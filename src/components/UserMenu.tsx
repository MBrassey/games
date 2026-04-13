"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import Avatar from "./Avatar";

export default function UserMenu({
  handle,
  avatar,
  githubLogin,
  signOut,
}: {
  handle: string;
  avatar: string | null;
  githubLogin?: string | null;
  signOut: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [, startTransition] = useTransition();

  // Close on outside click + escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-sm transition-colors hover:bg-eldritch-deep/40 pl-0.5 pr-2 py-0.5"
        aria-haspopup="menu"
        aria-expanded={open}
        title="account menu"
      >
        <Avatar src={avatar} handle={handle} size={32} radius={7} />
        <span className="hidden sm:inline text-[0.72rem] font-mono tracking-[0.14em] text-bone/85 group-hover:text-abyss-cyan max-w-[160px] truncate">
          {handle}
        </span>
        <span className="text-[0.65rem] text-bone/40 ml-0.5">▾</span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-[calc(100%+6px)] w-60 panel panel-glow p-0 overflow-hidden"
        >
          <div className="flex items-center gap-3 border-b border-eldritch-deep/50 px-3 py-3 bg-void-1/60">
            <Avatar src={avatar} handle={handle} size={36} radius={8} />
            <div className="min-w-0">
              <div className="text-xs font-mono tracking-wider text-abyss-cyan glow-cyan truncate">{handle}</div>
              {githubLogin && (
                <div className="text-[0.65rem] text-bone/50 truncate">@{githubLogin} · github</div>
              )}
            </div>
          </div>
          <nav className="py-1.5">
            <MenuLink href="/stats" label="Telemetry" hint="sessions & saves" onClick={() => setOpen(false)} />
            <MenuLink href="/" label="Library" hint="return to catalog" onClick={() => setOpen(false)} />
          </nav>
          <div className="border-t border-eldritch-deep/50 p-1.5">
            <button
              type="button"
              className="w-full text-left px-3 py-2 text-[0.72rem] uppercase tracking-[0.22em] text-blood-red hover:bg-blood-red/10 hover:text-blood-red transition-colors"
              onClick={() => {
                setOpen(false);
                startTransition(() => {
                  void signOut();
                });
              }}
            >
              ▸ Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function MenuLink({
  href,
  label,
  hint,
  onClick,
}: {
  href: string;
  label: string;
  hint?: string;
  onClick: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onClick}
      className="flex items-baseline justify-between px-3 py-2 text-[0.72rem] uppercase tracking-[0.22em] text-bone/80 hover:bg-eldritch-deep/30 hover:text-abyss-cyan transition-colors"
    >
      <span>▸ {label}</span>
      {hint && <span className="text-[0.6rem] tracking-normal normal-case text-bone/35">{hint}</span>}
    </Link>
  );
}
