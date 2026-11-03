"use client";

import { useEffect, useRef, useState } from "react";
import { PERSONAL_DATA_CONSENT_VERSION } from "../types/identity-tax-inquiry";

export default function PersonalDataConsentDialog({
  schoolName,
  onCancel,
  onConfirm,
}: {
  schoolName: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [agreed, setAgreed] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  return (
    <dialog
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="personal-data-consent-title"
      onCancel={onCancel}
      className="border-themed bg-card text-t1 max-w-2xl overflow-y-auto rounded-lg border p-4 shadow-lg"
      style={{ margin: "auto", width: "calc(100% - 2rem)", maxHeight: "85dvh" }}
    >
      <h2 id="personal-data-consent-title" className="text-lg font-semibold">
        個人資料授權
      </h2>
      <p className="text-t3 mt-1 text-xs">
        註冊身分與財稅查調・告知版本 {PERSONAL_DATA_CONSENT_VERSION}
      </p>
      <p className="text-t2 mt-3 text-sm">
        依個人資料保護法第 8 條，於本次送出確認前告知下列事項，請詳閱後決定是否同意。
      </p>
      <ol className="text-t2 mt-3 list-decimal space-y-3 pl-5 text-sm">
        <li>
          <strong>蒐集機關：</strong>{schoolName || "本校"}。
        </li>
        <li>
          <strong>蒐集目的：</strong>辦理本學期註冊身分確認、學雜費減免或補助資格審核，
          以及所選身分別必要的財稅查調；不作與上述目的無關的利用。
        </li>
        <li>
          <strong>資料類別：</strong>既有名冊中的學生姓名、學號與班級等身分資料、
          本次勾選的註冊身分別與進階選項、查調對象及其身分證字號、備註、
          必要的查調結果與本次同意紀錄。財稅查調欄位不另蒐集父母、本人或監護人的姓名。
        </li>
        <li>
          <strong>利用期間、地區、對象及方式：</strong>
          於上述目的存續及依法應保存的期間內，供本校授權承辦人員、依法受託處理者，
          以及有權辦理本案的教育、財稅等機關，以紙本、電子或資訊系統方式處理及利用。
          地區包含中華民國境內及本校依法使用之資訊系統、受託服務所在地；
          保存期限屆滿且無其他法定保存事由時，依法刪除或停止利用。
        </li>
        <li>
          <strong>當事人權利及行使方式：</strong>
          您得依個人資料保護法第 3 條，向本校教務處承辦單位請求查詢、閱覽、
          製給複製本、補充或更正、停止蒐集處理利用或刪除；亦可洽詢撤回同意。
          本校依適用法令辦理，依法應保存或執行職務所必要者，將說明無法辦理的原因。
        </li>
        <li>
          <strong>自由選擇及不提供的影響：</strong>
          您可選擇不同意或不提供資料；未同意即不送出本次線上確認，
          資料不足可能影響身分、減免或補助資格審核，請洽本校承辦單位確認替代辦理方式。
          提供父母或監護人等他人資料前，應向當事人告知並取得合法提供及查調所需的授權；
          未成年學生應先請法定代理人閱讀確認。
        </li>
      </ol>
      <label className="border-themed mt-4 flex items-start gap-2 rounded border p-3 text-sm">
        <input
          type="checkbox"
          className="mt-1 shrink-0"
          checked={agreed}
          onChange={(event) => setAgreed(event.target.checked)}
        />
        <span>
          本人已閱讀上述告知事項，同意本校於所述目的及範圍內蒐集、處理及利用本次資料，
          並於必要時辦理財稅查調；涉及他人資料或未成年學生時，已完成上述告知及授權確認。
          本次同意不沿用至下次送出。
        </span>
      </label>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button type="button" className="btn-theme rounded px-4 py-2 text-sm" onClick={onCancel}>
          取消
        </button>
        <button
          type="button"
          className="btn-primary rounded px-4 py-2 text-sm disabled:opacity-50"
          disabled={!agreed}
          onClick={() => {
            if (agreed) onConfirm();
          }}
        >
          同意並送出確認
        </button>
      </div>
    </dialog>
  );
}
