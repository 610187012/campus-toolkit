import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase-admin";
import { requireModulePermission, toAuthResponse } from "@/lib/dal";
import { enforceRateLimit, RATE } from "@/lib/rate-limit";
import { getCurrentPeriod } from "@/lib/settings-server";
import { isActiveEntry } from "@/lib/roster";
import { rosterCollection } from "@/types/roster";
import type { StudentOption } from "../../../../types/self-directed-learning";

const noStore = { "Cache-Control": "no-store" };
const MAX_CLASS_CODE = 20;
const MAX_STUDENTS = 60;

/**
 * 審查對象「個人」的班級學生候選：
 * 只在管理人員選定班級時載入該班（上限 60 筆），避免一次讀取全校學生。
 * GET /api/admin/self-directed-learning/students?classCode=301
 */
export async function GET(request: NextRequest) {
  try {
    const limited = enforceRateLimit(
      request,
      "self-directed-learning-admin",
      RATE.SELF_DIRECTED_LEARNING_ADMIN.limit,
      RATE.SELF_DIRECTED_LEARNING_ADMIN.windowMs
    );
    if (limited) return limited;

    const { denial } = await requireModulePermission("selfDirectedLearning", "configure");
    if (denial) return toAuthResponse(denial);

    const classCode = (request.nextUrl.searchParams.get("classCode") ?? "").trim();
    if (!classCode || classCode.length > MAX_CLASS_CODE) {
      return NextResponse.json(
        { success: false, message: "請提供有效的班級代碼" },
        { status: 400, headers: noStore }
      );
    }

    const period = await getCurrentPeriod();
    const snap = await getAdminDb()
      .collection(rosterCollection("student"))
      .where("academicYear", "==", period.academicYear)
      .where("semester", "==", period.semester)
      .where("classCode", "==", classCode)
      .limit(MAX_STUDENTS)
      .get();

    const students: StudentOption[] = snap.docs
      .map((doc) => (doc.data() || {}) as Record<string, unknown>)
      .filter(isActiveEntry)
      .map((raw) => ({
        uid: typeof raw.uid === "string" ? raw.uid : "",
        name: typeof raw.name === "string" ? raw.name.trim() : "",
        classCode: typeof raw.classCode === "string" ? raw.classCode.trim() : classCode,
        className: typeof raw.className === "string" ? raw.className.trim() : "",
        grade: typeof raw.grade === "string" ? raw.grade.trim() : "",
      }))
      .filter((student) => student.uid)
      .sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));

    return NextResponse.json({ success: true, students }, { headers: noStore });
  } catch (error) {
    console.error("selfDirectedLearning student options GET error:", error);
    return NextResponse.json(
      {
        success: false,
        message:
          process.env.NODE_ENV !== "production" && error instanceof Error
            ? error.message
            : "讀取學生名單失敗",
      },
      { status: 500, headers: noStore }
    );
  }
}
