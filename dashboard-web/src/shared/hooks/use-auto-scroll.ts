import { useEffect, useRef, useState } from 'react'

/**
 * A hook that provides auto-scroll functionality for scrollable containers.
 * Automatically scrolls to bottom on initial load and when content updates,
 * but only if user is already at the bottom to avoid interrupting manual scrolling.
 * 
 * @param dependency - The dependency that triggers a scroll when it changes (e.g. number of items)
 * @param threshold - Pixel threshold to consider "at the bottom", default 1px
 * @returns Object containing ref to attach to scroll container, scrollToBottom function, and shouldAutoScroll state
 */
export function useAutoScroll(
  dependency: number,
  threshold: number = 1
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [shouldAutoScroll, setShouldAutoScroll] = useState(true)
  const previousDependency = useRef(dependency)

  /**
   * Check if current scroll position is at the bottom of the container
   */
  const checkIfAtBottom = (): boolean => {
    const container = containerRef.current
    if (!container) return true

    const { scrollTop, scrollHeight, clientHeight } = container
    return scrollHeight - scrollTop - clientHeight <= threshold
  }

  /**
   * Scroll to the bottom of the container
   */
  const scrollToBottom = () => {
    const container = containerRef.current
    if (!container) return

    container.scrollTop = container.scrollHeight
  }

  /**
   * Handle scroll event to update shouldAutoScroll state
   */
  const handleScroll = () => {
    const isAtBottom = checkIfAtBottom()
    setShouldAutoScroll(isAtBottom)
  }

  /**
   * Scroll to bottom on initial mount after content renders
   */
  useEffect(() => {
    if (containerRef.current) {
      const timer = setTimeout(() => {
        scrollToBottom()
      }, 100)
      return () => clearTimeout(timer)
    }
  }, [])

  /**
   * Auto-scroll when dependency changes if we should auto-scroll
   */
  useEffect(() => {
    if (dependency > previousDependency.current || previousDependency.current === 0) {
      if (shouldAutoScroll) {
        // Small delay to wait for new content to render
        setTimeout(() => {
          scrollToBottom()
        }, 50)
      }
    }

    previousDependency.current = dependency
  }, [dependency, shouldAutoScroll])

  return {
    containerRef,
    handleScroll,
    scrollToBottom,
    shouldAutoScroll,
  }
}
