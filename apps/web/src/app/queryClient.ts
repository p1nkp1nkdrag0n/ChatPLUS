import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      retry: (count, error) => {
        if (
          error instanceof Error &&
          "status" in error &&
          Number(error.status) < 500
        )
          return false;
        return count < 1;
      },
      refetchOnWindowFocus: false,
    },
    mutations: { retry: false },
  },
});
