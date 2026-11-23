/**
 * Non-DOM-duplicating shimmer overlay rendered via CSS `::before { content: attr(data-text); }`
 * so text queries see a single text node while only compositor-safe transforms animate.
 */
export function ShimmerOverlay({ text }: { text: string }) {
  return (
    <span className="status-shimmer-track" aria-hidden="true">
      <span className="status-shimmer-mask">
        <span className="status-shimmer-beam" data-text={text} />
      </span>
    </span>
  );
}

export function StatusShimmer({ text, className }: { text: string; className?: string }) {
  return (
    <span className={className ? `status-shimmer ${className}` : "status-shimmer"}>
      {text}
      <ShimmerOverlay text={text} />
    </span>
  );
}
