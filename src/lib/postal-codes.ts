import "server-only";
import { getAdminDbRaw } from "@/lib/firebase-admin";
import { cachedSettingDoc, invalidateReadCache } from "@/lib/read-cache";
import { SETTINGS_COLLECTION } from "@/lib/settings-server";
import {
  POSTAL_CODES_DOC_ID,
  readPostalCodeOptions,
  type PostalCodeOption,
} from "@/types/postal-codes";

export async function getPostalCodeOptions(): Promise<PostalCodeOption[]> {
  try {
    const raw = await cachedSettingDoc(POSTAL_CODES_DOC_ID, async () => {
      const snap = await getAdminDbRaw().collection(SETTINGS_COLLECTION).doc(POSTAL_CODES_DOC_ID).get();
      return snap.exists ? snap.data() ?? null : null;
    });
    return readPostalCodeOptions(raw);
  } catch (error) {
    console.error("Postal code options read error:", error);
    return readPostalCodeOptions(null);
  }
}

export async function savePostalCodeOptions(options: PostalCodeOption[]): Promise<void> {
  await getAdminDbRaw().collection(SETTINGS_COLLECTION).doc(POSTAL_CODES_DOC_ID).set({
    options,
    updatedAt: Date.now(),
  });
  invalidateReadCache(`setting-doc:${POSTAL_CODES_DOC_ID}`);
}
