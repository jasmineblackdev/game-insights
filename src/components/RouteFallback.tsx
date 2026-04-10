/** Shown while lazy route chunks load — copy hints at network issues without blaming the user. */
export function RouteFallback() {
  return (
    <div className="min-h-[50vh] flex flex-col items-center justify-center gap-3 text-muted-foreground px-4 py-16">
      <div
        className="h-10 w-10 border-2 border-primary border-t-transparent rounded-full animate-spin shrink-0"
        aria-hidden
      />
      <p className="text-sm text-center max-w-sm">
        Loading this section… On a slow connection this can take a few seconds. If it never finishes, check your
        network or try a refresh.
      </p>
    </div>
  );
}
