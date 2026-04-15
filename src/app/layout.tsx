import type { Metadata, Viewport } from "next";
import "./globals.css";
import RouteSfx from "@/components/RouteSfx";
import SoundBoot from "@/components/SoundBoot";
import BackgroundFX from "@/components/BackgroundFX";
import UiEffects from "@/components/UiEffects";

export const metadata: Metadata = {
  title: "GAMES // brassey.io",
  description: "A terminal for LÖVE2D games. Play, save across devices, chat.",
  metadataBase: new URL("https://games.brassey.io"),
  openGraph: {
    title: "GAMES // brassey.io",
    description: "A terminal for LÖVE2D games.",
    type: "website",
  },
  icons: {
    icon: [{ url: "/favicon.svg", type: "image/svg+xml" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#030208",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <BackgroundFX />
        <SoundBoot />
        <RouteSfx />
        {/* #ui-shake is the transform root consumed by UiEffects for
            shake/zoom. Keeping the starfield OUTSIDE this wrapper means
            the background stays still while the UI rumbles — reads as
            the game shaking the cabinet, not the room. */}
        <div id="ui-shake" className="relative z-10">{children}</div>
        <UiEffects />
      </body>
    </html>
  );
}
