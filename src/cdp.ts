import { setTimeout as sleep } from "node:timers/promises";

export interface CdpVersionInfo {
  Browser: string;
  "Protocol-Version": string;
  webSocketDebuggerUrl: string;
}

export interface CdpTargetInfo {
  id: string;
  title: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string };
}

type EventHandler = (params: unknown) => void;

function endpoint(port: number, path: string): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Puerto CDP invalido: ${port}`);
  }
  return `http://127.0.0.1:${port}${path}`;
}

async function readJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`CDP HTTP ${response.status} en ${url}`);
  }
  return response.json() as Promise<T>;
}

export async function getVersion(port: number): Promise<CdpVersionInfo> {
  return readJson<CdpVersionInfo>(endpoint(port, "/json/version"));
}

export async function listTargets(port: number): Promise<CdpTargetInfo[]> {
  return readJson<CdpTargetInfo[]>(endpoint(port, "/json/list"));
}

export async function createTarget(port: number, url: string): Promise<CdpTargetInfo> {
  const response = await fetch(endpoint(port, `/json/new?${encodeURIComponent(url)}`), { method: "PUT" });
  if (!response.ok) {
    throw new Error(`No se pudo crear target CDP (${response.status})`);
  }
  return response.json() as Promise<CdpTargetInfo>;
}

export async function ensureWhatsAppTarget(port: number): Promise<CdpTargetInfo> {
  const targets = await listTargets(port);
  const existing = targets.find((target) =>
    target.type === "page" &&
    target.url.startsWith("https://web.whatsapp.com")
  );
  if (existing?.webSocketDebuggerUrl) return existing;
  return createTarget(port, "https://web.whatsapp.com");
}

export class CdpSession {
  private readonly ws: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly eventHandlers = new Map<string, Set<EventHandler>>();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (event) => {
      const payload = JSON.parse(String(event.data)) as CdpMessage;
      if (payload.method) {
        const handlers = this.eventHandlers.get(payload.method);
        if (handlers) {
          for (const handler of handlers) {
            handler(payload.params);
          }
        }
      }
      if (!payload.id) return;
      const job = this.pending.get(payload.id);
      if (!job) return;
      this.pending.delete(payload.id);
      if (payload.error) {
        job.reject(new Error(payload.error.message ?? "CDP error"));
        return;
      }
      job.resolve(payload.result);
    });
    ws.addEventListener("close", () => {
      for (const [id, job] of this.pending.entries()) {
        this.pending.delete(id);
        job.reject(new Error(`Conexion CDP cerrada antes de responder al request ${id}`));
      }
    });
  }

  static async connect(targetWsUrl: string): Promise<CdpSession> {
    const ws = new WebSocket(targetWsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("No se pudo abrir el websocket CDP")), { once: true });
    });
    const session = new CdpSession(ws);
    await session.send("Runtime.enable");
    await session.send("Page.enable");
    return session;
  }

  async close(): Promise<void> {
    this.ws.close();
    await sleep(50);
  }

  async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    });
    this.ws.send(payload);
    return promise;
  }

  on(method: string, handler: EventHandler): () => void {
    let handlers = this.eventHandlers.get(method);
    if (!handlers) {
      handlers = new Set<EventHandler>();
      this.eventHandlers.set(method, handlers);
    }
    handlers.add(handler);
    return () => {
      const current = this.eventHandlers.get(method);
      if (!current) return;
      current.delete(handler);
      if (!current.size) {
        this.eventHandlers.delete(method);
      }
    };
  }

  waitForEvent<T = unknown>(
    method: string,
    predicate?: (params: T) => boolean,
    timeoutMs = 30000
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const cleanup = this.on(method, (rawParams) => {
        const params = rawParams as T;
        if (predicate && !predicate(params)) return;
        clearTimeout(timer);
        cleanup();
        resolve(params);
      });

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timeout esperando evento CDP ${method}`));
      }, timeoutMs);
    });
  }

  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.send<{
      result: {
        type: string;
        subtype?: string;
        value?: T;
        description?: string;
      };
      exceptionDetails?: { text?: string };
    }>("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });

    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text ?? "Runtime.evaluate fallo");
    }
    if (result.result.subtype === "error") {
      throw new Error(result.result.description ?? "Error en Runtime.evaluate");
    }
    return result.result.value as T;
  }
}
