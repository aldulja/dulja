import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { useState, type ReactNode } from "react";

/**
 * A one-route memory router wrapped around whatever it is given.
 *
 * `AppShell`'s nav link and the login screen's next-step link are TanStack `<Link>`s rather than
 * plain anchors — an anchor is a full document navigation, which reloads the renderer and discards
 * a session the OS keyring refused to persist. `<Link>` calls `useRouter()`, so a component that
 * renders one cannot be rendered bare any more; this supplies the least router that satisfies it,
 * without the real tree's guards.
 */
export function RouterAround({ children }: { children: ReactNode }) {
  const [router] = useState(() => {
    const rootRoute = createRootRoute();
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => children,
    });
    return createRouter({
      routeTree: rootRoute.addChildren([indexRoute]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
  });
  return <RouterProvider router={router} />;
}
