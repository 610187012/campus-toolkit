"use client";

import { useEffect, useRef } from "react";

export type ToastKind = "success" | "error";

export interface ToastMessage {
  kind: ToastKind;
  text: string;
}

export default function Toast({
  message,
  onClose,
  durationMs = 2000,
}: {
  message: ToastMessage | null;
  onClose: () => void;
  durationMs?: number;
}) {
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => onCloseRef.current(), durationMs);
    return () => window.clearTimeout(timer);
  }, [message, durationMs]);

  if (!message) return null;

  return (
    <div
      role={message.kind === "error" ? "alert" : "status"}
      aria-live={message.kind === "error" ? "assertive" : "polite"}
      aria-atomic="true"
      className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg px-5 py-3 text-sm shadow-lg animate-fade-in"
      style={{
        background: `var(${message.kind === "success" ? "--success" : "--danger"})`,
        color: "#fff",
      }}
    >
      {message.text}
    </div>
  );
}
