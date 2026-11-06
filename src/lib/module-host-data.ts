import "server-only";
import { getAdminDb } from "@/lib/firebase-admin";
import { SETTINGS_COLLECTION } from "@/lib/settings-server";
import {
  PERIODS_DOC_ID,
  readSchoolPeriods,
  type SchoolPeriodsSetting,
} from "@/types/school-periods";
import {
  SPACES_DOC_ID,
  readSpaceStructure,
  type SpaceStructure,
} from "@/types/school-spaces";
import {
  CLASSES_DOC_ID,
  readSchoolClasses,
  type SchoolClassesSetting,
} from "@/types/school-classes";

/**
 * 選用模組的「主程式學校設定」唯讀公開面。
 *
 * 目的：模組不要直接 `getAdminDb().collection("settings").doc(...)`，
 * 一律透過這裡的語意函式讀取；主程式日後改 settings 結構時只需改這一層。
 * 只讀，不提供寫入；寫入仍走主程式管理端 API。
 */

async function readSettingsDoc(docId: string): Promise<Record<string, unknown> | null> {
  const snap = await getAdminDb().collection(SETTINGS_COLLECTION).doc(docId).get();
  return snap.exists ? ((snap.data() ?? null) as Record<string, unknown> | null) : null;
}

/** 課表作息（settings/schoolPeriods）：上課星期與節次；缺檔回主程式內建預設 */
export async function getSchoolPeriodsSetting(): Promise<SchoolPeriodsSetting> {
  return readSchoolPeriods(await readSettingsDoc(PERIODS_DOC_ID));
}

/** 樓層空間（settings/spaces）：層級與扁平空間清單；缺檔回主程式內建預設 */
export async function getSchoolSpaceStructure(): Promise<SpaceStructure> {
  return readSpaceStructure(await readSettingsDoc(SPACES_DOC_ID));
}

/** 年段班級（settings/schoolClasses）：年段與班級清單；缺檔回主程式內建預設 */
export async function getSchoolClassesSetting(): Promise<SchoolClassesSetting> {
  return readSchoolClasses(await readSettingsDoc(CLASSES_DOC_ID));
}
