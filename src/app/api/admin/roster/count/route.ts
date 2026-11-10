import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase-admin";
import { requireAdminModule, toAuthResponse } from "@/lib/dal";
import { enforceRateLimitShared, RATE } from "@/lib/rate-limit";
import { serverErrorMessage } from "@/lib/api-error";
import { getCurrentPeriod } from "@/lib/settings-server";
import { ALL_ROLES } from "@/types/users";
import { rosterCollection, type RosterRole } from "@/types/roster";

const noStore = { "Cache-Control": "no-store" };

/**
 * GET：四種名冊本期條目統計（省流模式用）——
 * 每張名冊以 count 聚合（每筆僅 1 次讀取、不載入文件內容）取本期總數，
 * 讓管理員在不載入整份名冊的前提下掌握各名冊筆數。
 */
export async function GET(request: NextRequest) {
  try {
    const limited = await enforceRateLimitShared(
      request,
      "roster-list",
      RATE.ROSTER_LIST.limit,
      RATE.ROSTER_LIST.windowMs
    );
    if (limited) return limited;

    const { denial } = await requireAdminModule("roster");
    if (denial) return toAuthResponse(denial);

    const period = await getCurrentPeriod();
    const snapshots = await Promise.all(
      ALL_ROLES.map((role) =>
        getAdminDb()
          .collection(rosterCollection(role))
          .where("academicYear", "==", period.academicYear)
          .where("semester", "==", period.semester)
          .count()
          .get()
      )
    );
    const counts = Object.fromEntries(
      ALL_ROLES.map((role, index) => [role, snapshots[index].data().count])
    ) as Record<RosterRole, number>;
    return NextResponse.json({ success: true, counts, period }, { headers: noStore });
  } catch (error) {
    console.error("Roster count error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "讀取名冊統計失敗") },
      { status: 500, headers: noStore }
    );
  }
}
