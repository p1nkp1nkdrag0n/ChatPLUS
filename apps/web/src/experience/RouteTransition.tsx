import { useEffect, useRef, type ReactNode } from "react";
import { NavigationType, useNavigationType } from "react-router-dom";

// A visual entrance only: navigation, data loading and mutations never wait for it.
// Unmounting removes the CSS animation immediately, including rapid navigation.
export function RouteTransition({
  children,
  title,
}: {
  children: ReactNode;
  title: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const navigationType = useNavigationType();

  useEffect(() => {
    const previousTitle = document.title;
    document.title = title;
    return () => {
      document.title = previousTitle;
    };
  }, [title]);

  useEffect(() => {
    const heading = container.current?.querySelector<HTMLElement>("h1");
    heading?.focus({ preventScroll: true });
    if (navigationType !== NavigationType.Pop)
      window.scrollTo({ top: 0, behavior: "instant" });
  }, [navigationType]);

  return (
    <div className="experience-transition" ref={container}>
      {children}
    </div>
  );
}
