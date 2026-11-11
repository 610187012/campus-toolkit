"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Settings, defaultSettings } from "@/types/settings";
import { UserRole, ROLE_HOME, ROLE_LABELS } from "@/types/users";
import { fetchSession, logout } from "@/lib/session";
import Copyright from "@/components/Copyright";
import AdSense from "@/components/AdSense";
import HomepageCornerCastle from "@/components/HomepageCornerCastle";
import GameShortcutArea from "@/components/GameShortcutArea";
import DraggableModuleGrid from "@/components/DraggableModuleGrid";
import RoleSwitcher from "@/components/RoleSwitcher";
import ModuleIcon from "@/components/ModuleIcon";
import AnnouncementReminderBell from "@/components/AnnouncementReminderBell";
import AnnouncementSurface from "@/components/AnnouncementSurface";
import CalendarSurface from "@/components/CalendarSurface";
import { fetchSettings } from "@/lib/settings-client";
import { FEATURE_MODULES } from "@/types/feature-modules";
import { moduleCardLabels } from "@/lib/module-card-label";

const accountModule = {
  icon: (
    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
    </svg>
  ),
  label: "帳號、身分與安全管理",
};

// 齒輪圖示與管理員首頁「系統設定」卡一致（主程式必有的子功能）
const settingsModule = {
  icon: (
    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.044-.146.087-.22-.128-.332-.183.582-.495.644-.869l.214-1.281z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  ),
  label: "系統設定",
};

export default function RoleHome({ role }: { role: Exclude<UserRole, "admin"> }) {
  const router = useRouter();
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [displayName, setDisplayName] = useState("");
  // 可見功能模組清單；null＝尚未載入（先顯示既有卡片，避免閃爍）
  const [visibleModules, setVisibleModules] = useState<string[] | null>(null);
  /** 被指派管理的功能模組（如行事曆）：首頁提供「管理」入口卡 */
  const [delegatedModules, setDelegatedModules] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetchSession(true).then((session) => {
      if (cancelled) return;
      if (!session || session.role !== role) {
        router.push("/");
        return;
      }
      setDisplayName(session.displayName);
      setDelegatedModules((session.delegatedModules ?? []).map((grant) => grant.module));
    });
    return () => {
      cancelled = true;
    };
  }, [router, role]);

  useEffect(() => {
    let cancelled = false;
    async function loadSettings() {
      try {
        const data = await fetchSettings();
        if (cancelled) return;
        if (data?.success && data.settings) {
          setSettings({ ...defaultSettings, ...data.settings });
        }
        // 目前身分可見的功能模組（提供功能 AND 顯示與否）
        if (data && Array.isArray(data.visibleModules)) {
          setVisibleModules(data.visibleModules);
        }
      } catch (error) {
        console.error("載入設定失敗:", error);
      }
    }
    loadSettings();
    return () => {
      cancelled = true;
    };
  }, []);

  function handleLogout() {
    void logout();
    router.push("/");
  }

  const roleLabel = ROLE_LABELS[role];
  const accountHref = `${ROLE_HOME[role]}/account`;
  const settingsHref = `${ROLE_HOME[role]}/settings`;
  const announcementsHref = `${ROLE_HOME[role]}/announcements`;
  // 行事曆：全站統一行事曆頁 /calendar（無身分差異；可見性由 API 依 session 過濾）
  const calendarHref = "/calendar";
  // 功能入口卡片：順序比照主程式管理員首頁
  // 「帳號、身分與安全管理」「公告」「行事曆」依功能模組「功能入口」過濾
  // 個人「設定」頁為個人偏好、非功能模組入口，不套顯示開關
  const accountVisible =
    visibleModules === null || visibleModules.includes("account");
  const announcementsVisible =
    visibleModules === null || visibleModules.includes("announcements");
  const calendarVisible = visibleModules === null || visibleModules.includes("calendar");
  const personalInfoVisible =
    visibleModules === null || visibleModules.includes("personalInfo");
  // 休閒歡樂誠：首頁左上角遊戲浮動按鈕（依功能入口開關顯示）
  const recreationVisible =
    visibleModules === null || visibleModules.includes("recreation");
  const entryCards = [
    { ...settingsModule, id: "settings", href: settingsHref },
    ...(accountVisible ? [{ ...accountModule, id: "account", href: accountHref }] : []),
    ...(announcementsVisible
      ? [
          {
            icon: <ModuleIcon value="announcements" />,
            label: "公告",
            id: "announcements",
            href: announcementsHref,
          },
        ]
      : []),
    ...(calendarVisible
      ? [
          {
            icon: <ModuleIcon value="calendar" />,
            label: "行事曆",
            id: "calendar",
            href: calendarHref,
          },
        ]
      : []),
    ...(personalInfoVisible
      ? [
          {
            icon: <ModuleIcon value="personalInfo" />,
            label: "學生個人資料",
            id: "personalInfo",
            href: `${ROLE_HOME[role]}/personal-info`,
          },
        ]
      : []),
    ...(recreationVisible
      ? [
          {
            icon: <ModuleIcon value="recreation" />,
            label: "休閒歡樂誠",
            id: "recreation",
            href: "/recreation",
          },
        ]
      : []),
  ];
  // 選用（外掛）功能模組卡：visibleModules 已含 provides＋顯示開關＋總開關（0.392）；
  // href 取該身分的入口（掃描器由 routes 映射的 roleHrefs）；無此身分頁面者不出卡。
  // 同名模組（例如兩個「自主學習計畫」不同作者版本）自動加作者名區分；
  // 只有一個同名模組時維持乾淨的功能名稱。
  const optionalItems =
    visibleModules === null
      ? []
      : FEATURE_MODULES.filter(
          (item) =>
            item.kind === "optional" &&
            visibleModules.includes(item.value) &&
            typeof item.roleHrefs?.[role] === "string"
        );
  const optionalLabels = moduleCardLabels(optionalItems);
  const optionalCards = optionalItems.map((item, index) => ({
    icon: <ModuleIcon value={item.value} />,
    label: optionalLabels[index],
    id: item.value,
    href: item.roleHrefs?.[role] as string,
  }));

  // 被指派管理且為內建模組（如行事曆）：提供直接進入管理頁的卡片
  const managementCards = FEATURE_MODULES.filter(
    (item) =>
      item.kind === "builtin" &&
      item.href !== "" &&
      Array.isArray(item.managerPermissions) &&
      item.managerPermissions.length > 0 &&
      delegatedModules.includes(item.value)
  ).map((item) => ({
    icon: <ModuleIcon value={item.value} />,
    label: `${item.label}管理`,
    id: `manage:${item.value}`,
    href: item.managerHref ?? item.href,
  }));

  return (
    <div className="min-h-screen flex flex-col items-center bg-page px-4 pt-[20px]">
      {recreationVisible && (
        <>
          <HomepageCornerCastle />
          <GameShortcutArea />
        </>
      )}
      <div className="text-center mb-2">
        <h1 className="text-4xl font-bold mb-2">{settings.systemName || "數位校園工具箱"}</h1>
        <p className="text-xl text-t2">{settings.schoolFullName || "學校名稱"}</p>
        <p className="text-lg text-t3">{settings.academicYear} 學年度 第{settings.semester}學期</p>
      </div>

      <div className="content-width mt-4 mb-2 text-center">
        <p className="mb-2 inline-flex rounded border border-warning/60 bg-warning/10 px-3 py-1 text-xs text-warning">
          功能建構中，陸續開放
        </p>
        <h2 className="text-2xl font-bold text-t1">{roleLabel}功能首頁</h2>
        {displayName && <p className="text-t2 mt-1">{displayName}，您好</p>}
        <RoleSwitcher role={role} />
      </div>

      {/* 系統公告：切換身分下拉選單下方、第一個登出按鈕上方。
          顯示與否由公告管理的「顯示位置」設定（5 處 surfaces）自行決定，
          不套功能模組顯示開關——顯示開關只藏下方入口卡（有提供功能但目前不開放） */}
      <AnnouncementSurface surface={role} className="content-width mb-3" />

      {/* 行程（單一行、尚未結束的第 1 則）：同上，由行事曆管理的「顯示位置」設定自管 */}
      <CalendarSurface surface={role} className="content-width mb-3" />

      <div className="content-width flex justify-end items-center gap-2 mb-4">
        {announcementsVisible && (
          <AnnouncementReminderBell role={role} href={announcementsHref} />
        )}
        <button onClick={handleLogout} className="btn-theme rounded-lg px-4 py-2 text-sm cursor-pointer">
          登出
        </button>
      </div>

      <hr className="content-width border-themed mb-4" />

      {/* 提示文字 + 可拖曳排序的功能卡片（順序存入此瀏覽器的 localStorage） */}
      <DraggableModuleGrid
        items={[...entryCards, ...managementCards, ...optionalCards]}
        storageKey={`campusCardOrder.${role}`}
        itemsReady={visibleModules !== null}
      />

      <hr className="content-width border-themed mb-4" />

      <div className="content-width mb-8">
        <button onClick={handleLogout} className="btn-theme rounded-lg px-4 py-2 text-sm cursor-pointer">
          登出
        </button>
      </div>

      {settings.sponsorAdEnabled && (
        <div className="content-width">
          <AdSense />
        </div>
      )}

      <div className="content-width mt-auto">
        <Copyright mode={settings.copyrightNotice ? "啟用" : "關閉"} />
      </div>
    </div>
  );
}
