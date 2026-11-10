import "server-only";
import type { Query } from "firebase-admin/firestore";
import { scopedDb } from "@/lib/module-db";
import { moduleSecret } from "@/lib/module-secret";
import { publishFromModule, updateFromModule } from "@/lib/announcements";
import { listCalendarEvents, publishScheduleFromModule } from "@/lib/calendar";
import { logActivity } from "@/lib/audit";
import { getCurrentPeriod, getCacheTtlSeconds, readSystemDoc } from "@/lib/settings-server";
import { loadPeriodEntries } from "@/lib/roster";
import {
  getSchoolClassesSetting,
  getSchoolPeriodsSetting,
  getSchoolSpaceStructure,
} from "@/lib/module-host-data";
import {
  requireAdminModule,
  requireModulePermission,
  requireRole,
  requireSuperAdmin,
  type VerifiedSession,
} from "@/lib/dal";
import { isAllowedSandboxUrl, parseAllowedHosts } from "@/lib/module-sandbox/network-policy";

/**
 * 沙箱子程序的宿主 RPC（P1-9 Phase 2C）。
 *
 * 子程序沒有 Firestore credential，也不能直接碰 session；所有敏感操作
 * 都回到這裡，由宿主用真正的 `scopedDb`／`verifySession` 執行。
 */

export type SandboxRpc = (method: string, params: unknown) => Promise<unknown> | unknown;

export interface HostRpcOptions {
  moduleValue: string;
  session: VerifiedSession;
  ip: string;
}

interface DbFilter {
  field: string;
  op: string;
  value: unknown;
}

interface DbQueryParams {
  collection: string;
  filters?: DbFilter[];
  orderBy?: { field: string; direction?: "asc" | "desc" };
  limit?: number;
  select?: string[];
}

interface DbDocParams {
  collection: string;
  id: string;
  data?: Record<string, unknown>;
}

interface DbBatchParams {
  ops?: Array<{
    type: "set" | "update" | "delete";
    collection: string;
    id: string;
    data?: Record<string, unknown>;
  }>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function queryFromParams(moduleValue: string, params: DbQueryParams): Query {
  const db = scopedDb(moduleValue);
  let query: Query = db.collection(params.collection);
  for (const filter of params.filters ?? []) {
    query = query.where(filter.field, filter.op as never, filter.value);
  }
  if (params.orderBy) {
    query = query.orderBy(params.orderBy.field, params.orderBy.direction ?? "asc");
  }
  if (typeof params.limit === "number" && params.limit >= 0) {
    query = query.limit(params.limit);
  }
  if (Array.isArray(params.select) && params.select.length > 0) {
    query = query.select(...params.select);
  }
  return query;
}

export function createHostRpc(options: HostRpcOptions): SandboxRpc {
  return async (method, rawParams) => {
    const params = asRecord(rawParams);

    switch (method) {
      case "session.get": {
        if (typeof params.requiredRole === "string") {
          return requireRole(params.requiredRole as never);
        }
        if (typeof params.moduleValue === "string") {
          return requireModulePermission(
            params.moduleValue,
            typeof params.permission === "string" ? params.permission : undefined
          );
        }
        if (params.superAdmin === true) {
          return requireSuperAdmin();
        }
        if (typeof params.module === "string") {
          return requireAdminModule(params.module as never);
        }
        return { session: options.session, denial: null };
      }

      case "secret.get": {
        const name = typeof params.name === "string" ? params.name : "default";
        return moduleSecret(options.moduleValue, name);
      }

      case "settings.period":
        return getCurrentPeriod();

      case "settings.cacheTtl":
        return getCacheTtlSeconds();

      case "settings.readSystemDoc":
        return readSystemDoc();

      case "host.schoolPeriods":
        return getSchoolPeriodsSetting();

      case "host.schoolClasses":
        return getSchoolClassesSetting();

      case "host.spaceStructure":
        return getSchoolSpaceStructure();

      case "calendar.list":
        return listCalendarEvents(params as never);

      case "roster.loadPeriodEntries": {
        const period = params.period as never;
        const role = params.role as never;
        const entries = await loadPeriodEntries(period, role);
        return [...entries.entries()];
      }

      case "audit.log": {
        await logActivity(params as never);
        return { ok: true };
      }

      case "hook.publishAnnouncement":
        return publishFromModule(params as never);

      case "hook.updateAnnouncement":
        return updateFromModule(params as never);

      case "hook.publishSchedule":
        return publishScheduleFromModule(params as never);

      case "net.fetch": {
        const url = String(params.url ?? "");
        const allowed = parseAllowedHosts(process.env.MODULE_SANDBOX_ALLOWED_HOSTS);
        if (!isAllowedSandboxUrl(url, allowed)) {
          throw new Error(`沙箱網路目的地未被允許：${url}`);
        }
        const method = typeof params.method === "string" ? params.method : "GET";
        const headers = asRecord(params.headers) as Record<string, string>;
        let body: BodyInit | undefined;
        if (typeof params.bodyBase64 === "string") {
          body = Buffer.from(params.bodyBase64, "base64");
        } else if (typeof params.body === "string") {
          body = params.body;
        }
        const response = await fetch(url, {
          method,
          headers,
          body,
          redirect: "manual",
          signal: AbortSignal.timeout(10_000),
        });
        if (response.status >= 300 && response.status < 400) {
          throw new Error("沙箱網路不允許重新導向");
        }
        const arrayBuffer = await response.arrayBuffer();
        if (arrayBuffer.byteLength > 2 * 1024 * 1024) {
          throw new Error("沙箱網路回應過大");
        }
        return {
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          body: Buffer.from(arrayBuffer).toString("base64"),
        };
      }

      case "db.query": {
        const query = queryFromParams(options.moduleValue, params as unknown as DbQueryParams);
        const snap = await query.get();
        return {
          rows: snap.docs.map((doc) => ({ id: doc.id, data: doc.data() })),
        };
      }

      case "db.count": {
        const query = queryFromParams(options.moduleValue, params as unknown as DbQueryParams);
        const snap = await query.count().get();
        return { count: snap.data().count };
      }

      case "db.doc.get": {
        const p = params as unknown as DbDocParams;
        const snap = await scopedDb(options.moduleValue).collection(p.collection).doc(p.id).get();
        return { exists: snap.exists, id: snap.id, data: snap.data() ?? null };
      }

      case "db.doc.set": {
        const p = params as unknown as DbDocParams;
        await scopedDb(options.moduleValue).collection(p.collection).doc(p.id).set(p.data ?? {});
        return { ok: true };
      }

      case "db.doc.update": {
        const p = params as unknown as DbDocParams;
        await scopedDb(options.moduleValue).collection(p.collection).doc(p.id).update(p.data ?? {});
        return { ok: true };
      }

      case "db.doc.delete": {
        const p = params as unknown as DbDocParams;
        await scopedDb(options.moduleValue).collection(p.collection).doc(p.id).delete();
        return { ok: true };
      }

      case "db.getAll": {
        const refs = Array.isArray(params.refs) ? params.refs : [];
        const db = scopedDb(options.moduleValue);
        const snapshots = await db.getAll(
          ...refs.map((ref) => {
            const p = asRecord(ref);
            return db.collection(String(p.collection)).doc(String(p.id));
          })
        );
        return {
          snapshots: snapshots.map((snap) => ({
            exists: snap.exists,
            id: snap.id,
            data: snap.data() ?? null,
          })),
        };
      }

      case "db.batch": {
        const p = params as unknown as DbBatchParams;
        const db = scopedDb(options.moduleValue);
        const batch = db.batch();
        for (const op of p.ops ?? []) {
          const ref = db.collection(op.collection).doc(op.id);
          if (op.type === "set") batch.set(ref, op.data ?? {});
          else if (op.type === "update") batch.update(ref, op.data ?? {});
          else batch.delete(ref);
        }
        await batch.commit();
        return { ok: true };
      }

      default:
        throw new Error(`沙箱尚未支援 RPC：${method}`);
    }
  };
}
