import { NextRequest, NextResponse } from "next/server";
import { assertSameOrigin } from "@/lib/csrf";
import { getClientIp, logActivity } from "@/lib/audit";
import { requireRole, toAuthResponse, type VerifiedSession } from "@/lib/dal";
import { enforceRateLimitShared, RATE } from "@/lib/rate-limit";
import { getCurrentPeriod } from "@/lib/settings-server";
import { serverErrorMessage } from "@/lib/api-error";
import { getPostalCodeOptions } from "@/lib/postal-codes";
import {
  getStudentPersonalIdentity,
  getStudentPersonalInfoEntries,
  getStudentPersonalInfoSettings,
  isStudentPersonalInfoOpen,
  saveStudentPersonalIdentity,
  saveStudentPersonalInfo,
  studentPersonalInfoAvailabilityMessage,
  taipeiDateTimeString,
  taipeiDateString,
} from "@/lib/personal-info";
import {
  EMPTY_STUDENT_PERSONAL_IDENTITY,
  EMPTY_STUDENT_PERSONAL_INFO_TERM,
  EMPTY_STUDENT_PERSONAL_INFO_PHOTOS,
  isIsoDate,
  isStudentPersonalInfoTargetEligible,
  validateStudentPersonalId,
  STUDENT_PERSONAL_IDENTITY_FIELD_DEFS,
  STUDENT_PERSONAL_INFO_TERM_FIELD_DEFS,
  type StudentPersonalIdentityFields,
  type StudentPersonalInfoTermFields,
} from "@/types/personal-info";
import { readJsonBody } from "@/lib/http-body";

const noStore = { "Cache-Control": "no-store" };

type StudentIdentityValidation =
  | { ok: true; identity: StudentPersonalIdentityFields }
  | { ok: false; message: string };

function validateStudentIdentity(raw: unknown): StudentIdentityValidation {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, message: "請檢查性別、證件與生日資料格式" };
  }
  const input = raw as Record<string, unknown>;
  const fields = { ...EMPTY_STUDENT_PERSONAL_IDENTITY };
  for (const definition of STUDENT_PERSONAL_IDENTITY_FIELD_DEFS) {
    const rawValue = input[definition.key];
    const value = typeof rawValue === "string" ? rawValue.trim() : "";
    if (value.length > definition.maxLength) {
      return { ok: false, message: `${definition.label}長度不可超過 ${definition.maxLength} 字` };
    }
    fields[definition.key] = value;
  }
  const genderOptions = STUDENT_PERSONAL_IDENTITY_FIELD_DEFS.find(
    (field) => field.key === "gender"
  )?.options;
  if (fields.gender && !genderOptions?.some((option) => option.value === fields.gender)) {
    return { ok: false, message: "性別僅提供男、女" };
  }
  if (fields.birthday && (!isIsoDate(fields.birthday) || fields.birthday > taipeiDateString())) {
    return { ok: false, message: "生日格式無效或晚於今天" };
  }
  const idValidation = validateStudentPersonalId(fields.idType, fields.nationalId);
  if (!idValidation.ok) return { ok: false, message: idValidation.message };
  fields.nationalId = fields.nationalId.trim().toUpperCase();
  return { ok: true, identity: fields };
}

function validateStudentTermFields(raw: unknown): StudentPersonalInfoTermFields | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  const fields = { ...EMPTY_STUDENT_PERSONAL_INFO_TERM };
  for (const definition of STUDENT_PERSONAL_INFO_TERM_FIELD_DEFS) {
    const rawValue = input[definition.key];
    const value = typeof rawValue === "string" ? rawValue.trim() : "";
    if (value.length > definition.maxLength) return null;
    fields[definition.key as keyof StudentPersonalInfoTermFields] = value;
  }
  for (const postalCode of [fields.householdPostalCode, fields.mailingPostalCode]) {
    if (postalCode && !/^\d{3,6}$/.test(postalCode)) return null;
  }
  return fields;
}

/** 讀取學生本人本學期個人資料與填寫期間。 */
export async function GET(request: NextRequest) {
  try {
    const limited = await enforceRateLimitShared(
      request,
      "student-personal-info-get",
      RATE.ACCOUNT_GET.limit,
      RATE.ACCOUNT_GET.windowMs
    );
    if (limited) return limited;

    const { session, denial } = await requireRole("student");
    if (denial) return toAuthResponse(denial);

    const period = await getCurrentPeriod();
    const [settings, personalInfoEntries, postalCodeOptions] = await Promise.all([
      getStudentPersonalInfoSettings(period),
      getStudentPersonalInfoEntries(session.uid),
      getPostalCodeOptions(),
    ]);
    const identity = await getStudentPersonalIdentity(session.uid, personalInfoEntries);
    const currentEntry = personalInfoEntries.find(
      (entry) => entry.academicYear === period.academicYear && entry.semester === period.semester
    );
    const current =
      currentEntry ?? {
        academicYear: period.academicYear,
        semester: period.semester,
        fields: { ...EMPTY_STUDENT_PERSONAL_INFO_TERM },
        photos: { ...EMPTY_STUDENT_PERSONAL_INFO_PHOTOS },
        legacyIdentity: identity,
      };
    const previousEntries = personalInfoEntries.filter(
        (entry) => entry.academicYear !== period.academicYear || entry.semester !== period.semester
      );
    previousEntries.sort((a, b) => b.academicYear - a.academicYear || b.semester - a.semester);
    const entries = [current, ...previousEntries];
    const rosterEntry = (session as VerifiedSession).__entry;
    const currentDateTime = taipeiDateTimeString();
    const targetEligible = isStudentPersonalInfoTargetEligible(
      settings.target,
      rosterEntry?.grade,
      rosterEntry?.classCode
    );
    const canEdit = isStudentPersonalInfoOpen(settings, currentDateTime) && targetEligible;
    const photoPermissions = {
      admission: canEdit && settings.allowAdmissionPhotoReplacement,
      graduation: canEdit && settings.allowGraduationPhotoUpload,
    };
    const availabilityMessage = !isStudentPersonalInfoOpen(settings, currentDateTime)
      ? studentPersonalInfoAvailabilityMessage(settings, currentDateTime)
      : !targetEligible
        ? "本次開放填寫對象不包含你的年級或班級。"
        : studentPersonalInfoAvailabilityMessage(settings, currentDateTime);
    return NextResponse.json(
      {
        success: true,
        period,
        settings,
        identity,
        entries: entries.map((entry) => ({
          academicYear: entry.academicYear,
          semester: entry.semester,
          fields: entry.fields,
          photos: {
            admission: entry.photos.admission
              ? { updatedAt: entry.photos.admission.updatedAt }
              : null,
            graduation: entry.photos.graduation
              ? { updatedAt: entry.photos.graduation.updatedAt }
              : null,
          },
        })),
        photoPermissions,
        postalCodeOptions,
        canEdit,
        targetEligible,
        currentDateTime,
        message: availabilityMessage,
      },
      { headers: noStore }
    );
  } catch (error) {
    console.error("Get student personal info error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "讀取個人資料失敗") },
      { status: 500, headers: noStore }
    );
  }
}

/** 學生僅能在目前學期的開放期間編輯自己的資料。 */
export async function PUT(request: NextRequest) {
  try {
    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;

    const limited = await enforceRateLimitShared(
      request,
      "student-personal-info-save",
      RATE.ACCOUNT_UPDATE.limit,
      RATE.ACCOUNT_UPDATE.windowMs
    );
    if (limited) return limited;

    const { session, denial } = await requireRole("student");
    if (denial) return toAuthResponse(denial);

    const parsed = await readJsonBody<Record<string, unknown>>(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;
    if (!body || JSON.stringify(body).length > 10_000) {
      return NextResponse.json(
        { success: false, message: "個人資料內容無效或過大" },
        { status: 400, headers: noStore }
      );
    }
    const fields = validateStudentTermFields(body.fields);
    if (!fields) {
      return NextResponse.json(
        { success: false, message: "請檢查資料格式、郵遞區號與欄位長度" },
        { status: 400, headers: noStore }
      );
    }

    const period = await getCurrentPeriod();
    const settings = await getStudentPersonalInfoSettings(period);
    if (!isStudentPersonalInfoOpen(settings)) {
      return NextResponse.json(
        {
          success: false,
          message: studentPersonalInfoAvailabilityMessage(settings),
        },
        { status: 403, headers: noStore }
      );
    }
    const rosterEntry = (session as VerifiedSession).__entry;
    if (!isStudentPersonalInfoTargetEligible(settings.target, rosterEntry?.grade, rosterEntry?.classCode)) {
      return NextResponse.json(
        { success: false, message: "本次開放填寫對象不包含你的年級或班級" },
        { status: 403, headers: noStore }
      );
    }

    await saveStudentPersonalInfo(session.uid, period, fields);
    await logActivity({
      userId: session.uid,
      role: "student",
      action: "student_personal_info_updated",
      ip: getClientIp(request),
      details: `更新 ${period.academicYear} 學年度第 ${period.semester} 學期學生個人資料`,
    });

    return NextResponse.json(
      { success: true, message: "個人資料已儲存", fields },
      { headers: noStore }
    );
  } catch (error) {
    console.error("Save student personal info error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "儲存個人資料失敗") },
      { status: 500, headers: noStore }
    );
  }
}

/** 性別、身分證與生日屬於跨學期的固定資料，獨立以 uid 保存。 */
export async function PATCH(request: NextRequest) {
  try {
    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;

    const limited = await enforceRateLimitShared(
      request,
      "student-personal-identity-save",
      RATE.ACCOUNT_UPDATE.limit,
      RATE.ACCOUNT_UPDATE.windowMs
    );
    if (limited) return limited;

    const { session, denial } = await requireRole("student");
    if (denial) return toAuthResponse(denial);

    const parsed = await readJsonBody<Record<string, unknown>>(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;
    if (!body || JSON.stringify(body).length > 4_000) {
      return NextResponse.json(
        { success: false, message: "固定個人資料內容無效或過大" },
        { status: 400, headers: noStore }
      );
    }
    const identityValidation = validateStudentIdentity(body.identity);
    if (!identityValidation.ok) {
      return NextResponse.json(
        { success: false, message: identityValidation.message },
        { status: 400, headers: noStore }
      );
    }
    const identity = identityValidation.identity;

    const period = await getCurrentPeriod();
    const settings = await getStudentPersonalInfoSettings(period);
    if (!isStudentPersonalInfoOpen(settings)) {
      return NextResponse.json(
        { success: false, message: studentPersonalInfoAvailabilityMessage(settings) },
        { status: 403, headers: noStore }
      );
    }
    const rosterEntry = (session as VerifiedSession).__entry;
    if (!isStudentPersonalInfoTargetEligible(settings.target, rosterEntry?.grade, rosterEntry?.classCode)) {
      return NextResponse.json(
        { success: false, message: "本次開放填寫對象不包含你的年級或班級" },
        { status: 403, headers: noStore }
      );
    }

    await saveStudentPersonalIdentity(session.uid, identity);
    await logActivity({
      userId: session.uid,
      role: "student",
      action: "student_personal_info_updated",
      ip: getClientIp(request),
      details: "更新跨學期固定個人資料",
    });
    return NextResponse.json(
      { success: true, message: "固定個人資料已儲存", identity },
      { headers: noStore }
    );
  } catch (error) {
    console.error("Save student personal identity error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "儲存固定個人資料失敗") },
      { status: 500, headers: noStore }
    );
  }
}
