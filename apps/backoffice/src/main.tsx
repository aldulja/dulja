import "./lib/jitless";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { readEnv } from "./lib/env";
import { SessionProvider } from "./lib/session";
import { pickSessionStore } from "./lib/session-storage";
import { createSupabase } from "./lib/supabase";
import { createAppRouter } from "./router";
import "./app.css";

const root = document.getElementById("root");
if (root === null) throw new Error("index.html is missing #root");

// The composition root: env is read once, the store is chosen once, the client is built once.
// `readEnv()` runs here so a missing `VITE_*` fails at boot naming the variable rather than at the
// first fetch with a blank screen; `pickSessionStore()` chooses `localStorage` in a browser and the
// Electron bridge when `window.dulja.auth` exists, so this file serves both shells with no branch.
const env = readEnv();
const sessionStore = pickSessionStore();
const supabase = createSupabase(env, sessionStore);
// The router's guards ask this client whether there is a session and at what assurance level, so it
// is built from the same client the provider uses rather than a second one.
const router = createAppRouter(supabase);
const queryClient = new QueryClient();

createRoot(root).render(
  <StrictMode>
    {/* SessionProvider sits inside QueryClientProvider (its consumers use `useQuery`) and outside
        RouterProvider (every route is a consumer). The store is handed over as well as to the
        client, so a refused keyring write reaches the screen instead of passing silently. */}
    <QueryClientProvider client={queryClient}>
      <SessionProvider client={supabase} store={sessionStore}>
        <RouterProvider router={router} />
      </SessionProvider>
    </QueryClientProvider>
  </StrictMode>,
);
