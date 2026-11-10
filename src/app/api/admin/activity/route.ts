import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase-admin";
import { requireAdminModule, toAuthResponse } from "@/lib/dal";
import { enforceRateLimitShared, RATE } from "@/lib/rate-limit";
import { serverErrorMessage } from "@/lib/api-error";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * 稽核紀錄讀取（admin only）：依 timestamp 由新到舊分頁讀取 activityLog。
 * ?limit=1..200（預設 50）；?before=<timestamp> 取該時間之前的下一頁。
 */
export async function GET(request: NextRequest) {
  try {
    const { session, denial } = await requireAdminModule("activity");
    if (denial) return toAuthResponse(denial);

    const limited = await enforceRateLimitShared(
      request,
      "admin-activity",
      RATE.ADMIN_ACTIVITY.limit,
      RATE.ADMIN_ACTIVITY.windowMs
    );
    if (limited) return limited;

    const { searchParams } = request.nextUrl;
    const limitRaw = Number(searchParams.get("limit"));
    const limit = Number.isFinite(limitRaw)
      ? Math.min(MAX_LIMIT, Math.max(1, Math.floor(limitRaw)))
      : DEFAULT_LIMIT;
    const beforeRaw = Number(searchParams.get("before"));
    const before =
      Number.isFinite(beforeRaw) && beforeRaw > 0 ? beforeRaw : null;

    const col = getAdminDb().collection("activityLog");
    const base = before !== null ? col.where("timestamp", "<", before) : col;
    const snapshot = await base.orderBy("timestamp", "desc").limit(limit).get();

    const entries = snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        userId: typeof data.userId === "string" ? data.userId : "",
        role: typeof data.role === "string" ? data.role : "",
        action: data.action,
        timestamp: typeof data.timestamp === "number" ? data.timestamp : 0,
        ip: typeof data.ip === "string" ? data.ip : "",
        details: typeof data.details === "string" ? data.details : "",
      };
    });

    const nextBefore = entries.length === limit ? entries[entries.length - 1].timestamp : null;
    return NextResponse.json({ success: true, entries, nextBefore });
  } catch (error) {
    console.error("List activity error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "系統錯誤") },
      { status: 500 }
    );
  }
}
