import { auditConversations, type AuditConversationsOptions } from "./conversation-audit.js";
import type { AuditConversationItem, AuditConversationsResult } from "./conversation-audit-types.js";

export interface ConversationAttentionBoardSummary {
  totalChats: number;
  urgentNow: number;
  followUpToday: number;
  waitingOnCustomer: number;
  promisesToFulfill: number;
  stalledHighValue: number;
  healthy: number;
  monitoring: number;
}

export interface ConversationAttentionBoardBuckets {
  urgentNow: AuditConversationItem[];
  followUpToday: AuditConversationItem[];
  waitingOnCustomer: AuditConversationItem[];
  promisesToFulfill: AuditConversationItem[];
  stalledHighValue: AuditConversationItem[];
  healthy: AuditConversationItem[];
  monitoring: AuditConversationItem[];
}

export interface ConversationAttentionBoardResult {
  ok: true;
  profile: AuditConversationsResult["profile"];
  scope: AuditConversationsResult["scope"];
  count: number;
  summary: ConversationAttentionBoardSummary;
  topActions: string[];
  buckets: ConversationAttentionBoardBuckets;
  items: AuditConversationItem[];
  warnings: string[];
}

function hasHighSalesSignal(item: AuditConversationItem): boolean {
  return item.signals.includes("sales_signal_high");
}

function isUrgentNow(item: AuditConversationItem): boolean {
  return item.priority === "high" && item.waitingOn === "us";
}

function isFollowUpToday(item: AuditConversationItem): boolean {
  return (
    item.waitingOn === "us" &&
    (item.stallType === "follow_up_needed" ||
      item.stallType === "stalled_conversation" ||
      (item.priority !== "low" && item.idleMinutes !== null && item.idleMinutes >= 60))
  );
}

function isWaitingOnCustomer(item: AuditConversationItem): boolean {
  return item.waitingOn === "them" && item.status !== "healthy";
}

function isPromiseToFulfill(item: AuditConversationItem): boolean {
  return item.stallType === "unresolved_promise";
}

function isStalledHighValue(item: AuditConversationItem): boolean {
  return hasHighSalesSignal(item) && item.status !== "healthy";
}

function buildTopActions(summary: ConversationAttentionBoardSummary): string[] {
  const actions: string[] = [];
  if (summary.urgentNow > 0) {
    actions.push(`Responder ${summary.urgentNow} chat(es) urgentes que estan esperando al negocio.`);
  }
  if (summary.promisesToFulfill > 0) {
    actions.push(`Cumplir ${summary.promisesToFulfill} promesa(s) pendientes para evitar enfriamiento.`);
  }
  if (summary.followUpToday > 0) {
    actions.push(`Retomar ${summary.followUpToday} conversacion(es) que necesitan seguimiento hoy.`);
  }
  if (summary.stalledHighValue > 0) {
    actions.push(`Atacar ${summary.stalledHighValue} oportunidad(es) de alto valor antes de que se pierdan.`);
  }
  if (summary.waitingOnCustomer > 0) {
    actions.push(`Monitorear ${summary.waitingOnCustomer} chat(es) que quedaron esperando al cliente.`);
  }
  if (summary.monitoring > 0) {
    actions.push(`Revisar ${summary.monitoring} chat(es) sin urgencia inmediata que siguen activos en el tablero.`);
  }
  if (!actions.length) {
    actions.push("No se detectaron chats con atencion urgente en esta corrida.");
  }
  return actions;
}

export function buildConversationAttentionBoard(audit: AuditConversationsResult): ConversationAttentionBoardResult {
  const buckets: ConversationAttentionBoardBuckets = {
    urgentNow: [],
    followUpToday: [],
    waitingOnCustomer: [],
    promisesToFulfill: [],
    stalledHighValue: [],
    healthy: [],
    monitoring: [],
  };

  for (const item of audit.items) {
    if (isUrgentNow(item)) buckets.urgentNow.push(item);
    if (isFollowUpToday(item)) buckets.followUpToday.push(item);
    if (isWaitingOnCustomer(item)) buckets.waitingOnCustomer.push(item);
    if (isPromiseToFulfill(item)) buckets.promisesToFulfill.push(item);
    if (isStalledHighValue(item)) buckets.stalledHighValue.push(item);
    if (item.status === "healthy") buckets.healthy.push(item);
    if (
      !isUrgentNow(item) &&
      !isFollowUpToday(item) &&
      !isWaitingOnCustomer(item) &&
      !isPromiseToFulfill(item) &&
      !isStalledHighValue(item) &&
      item.status !== "healthy"
    ) {
      buckets.monitoring.push(item);
    }
  }

  const summary: ConversationAttentionBoardSummary = {
    totalChats: audit.items.length,
    urgentNow: buckets.urgentNow.length,
    followUpToday: buckets.followUpToday.length,
    waitingOnCustomer: buckets.waitingOnCustomer.length,
    promisesToFulfill: buckets.promisesToFulfill.length,
    stalledHighValue: buckets.stalledHighValue.length,
    healthy: buckets.healthy.length,
    monitoring: buckets.monitoring.length,
  };

  return {
    ok: true,
    profile: audit.profile,
    scope: audit.scope,
    count: audit.count,
    summary,
    topActions: buildTopActions(summary),
    buckets,
    items: audit.items,
    warnings: audit.warnings,
  };
}

export async function buildConversationAttentionBoardFromAudit(
  port: number,
  options: AuditConversationsOptions,
): Promise<ConversationAttentionBoardResult> {
  const audit = await auditConversations(port, options);
  return buildConversationAttentionBoard(audit);
}
