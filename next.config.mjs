/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async headers() {
    return [
      {
        // Game runtimes change on every rebuild. Serving them no-cache keeps
        // us from chasing stale `game.data` / `love.wasm` in the browser.
        // (They're ~5 MB; revisit if this becomes a bandwidth issue.)
        source: "/games/:slug/runtime/:path*",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
        ],
      },
    ];
  },
};
export default nextConfig;
