"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { sound } from "@/lib/sound";

// Plays the transition SFX whenever the app-router pathname changes.
// Mounted once in the root layout. Skips the very first render so we don't
// sweep on initial page load (the boot chime already handles that).
export default function RouteSfx() {
  const pathname = usePathname();
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    sound.transition();
  }, [pathname]);
  return null;
}
