import { cn } from "@/lib/utils";

const emojiSize = {
  sm: "text-2xl",
  md: "text-3xl",
  lg: "text-4xl",
} as const;

export function TeamLogo({
  logo,
  size = "sm",
  className,
}: {
  logo: string;
  size?: keyof typeof emojiSize;
  className?: string;
}) {
  if (logo.startsWith("http")) {
    const dim =
      size === "lg" ? "w-16 h-16" : size === "md" ? "w-12 h-12" : "w-8 h-8";
    return (
      <img
        src={logo}
        alt=""
        className={cn("object-contain shrink-0 mx-auto", dim, className)}
      />
    );
  }
  return (
    <div className={cn(emojiSize[size], "leading-none", className)}>{logo}</div>
  );
}
