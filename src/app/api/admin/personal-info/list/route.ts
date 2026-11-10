import { NextRequest, NextResponse } from "next/server";
import { enforceRateLimitShared, RATE } from "@/lib/rate-limit";
import { requireRole, toAuthResponse } from "@/lib/dal";
import { serverErrorMessage } from "@/lib/api-error";
import { getCurrentPeriod } from "@/lib/settings-server";
import {
  getStudentPersonalInfoTargetOptions,
  loadStudentPersonalInfoClassList,
} from "@/lib/personal-info";

const noStore = { "Cache-Control": "no-store" };

/**
 * GET：本期某班的學生個人資料列表（管理端，僅在使用者展開列表時呼叫）。
 *
 * 讀取範圍嚴格限定於指定班級（過濾下推），不載入全校名冊與個資內容；
 * 回傳欄位僅含學號、姓名、填寫狀態與更新時間。
 * `classCode` 省略時自動採用班級設定的第一個班級（前端預設也只讀第一個班級）。
 */
export async function GET(request: NextRequest) {
  try {
    const limited = await enforceRateLimitShared(
      request,
      "feature-modules",
      RATE.FEATURE_MODULES_GET.limit,
      RATE.FEATURE_MODULES_GET.windowMs
    );
    if (limited) return limited;

    const { denial } = await requireRole("admin");
    if (denial) return toAuthResponse(denial);

    const period = await getCurrentPeriod();
    const targetOptions = await getStudentPersonalInfoTargetOptions();
    const classes = targetOptions.grades.flatMap((grade) =>
      grade.classes.map((classRow) => ({
        code: classRow.value,
        name: classRow.label,
        gradeName: grade.label,
      }))
    );

    const requested = request.nextUrl.searchParams.get("classCode")?.trim() ?? "";
    const classCode = requested || classes[0]?.code || "";
    if (!classCode) {
      return NextResponse.json(
        { success: true, period, classes, classCode: "", rows: [] },
        { headers: noStore }
      );
    }

    const rows = await loadStudentPersonalInfoClassList(period, classCode);
    return NextResponse.json(
      { success: true, period, classes, classCode, rows },
      { headers: noStore }
    );
  } catch (error) {
    console.error("Student personal info list error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "讀取個人資料列表失敗") },
      { status: 500, headers: noStore }
    );
  }
}
