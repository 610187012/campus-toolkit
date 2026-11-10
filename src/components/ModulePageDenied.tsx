import type { ReactNode } from "react";

/** 模組頁面被 server-side 閘門擋下時的簡易頁面（不依賴模組程式碼） */
export default function ModulePageDenied({ message }: { message: string }): ReactNode {
  return (
    <main className="min-h-[60vh] flex items-center justify-center px-4 py-10">
      <section className="w-full max-w-md rounded-lg border border-themed bg-card p-6 text-center shadow-sm">
        <h1 className="text-lg font-bold text-t1">目前無法使用</h1>
        <p className="mt-2 text-sm text-t2">{message}</p>
        <a className="btn-theme mt-5 inline-block rounded px-4 py-2 text-sm font-medium" href="/">
          返回首頁
        </a>
      </section>
    </main>
  );
}
