import { useLayoutEffect, useRef, useState, useCallback } from "react";
import MessageBubble from "./MessageBubble";
import type { Conversation } from "../types";

interface ChatViewProps {
  conversation: Conversation | null;
  isGenerating: boolean;
}

function TypingIndicator() {
  return (
    <div className="flex justify-start mb-4 message-enter">
      <div className="bg-[var(--bg-assistant-msg)] rounded-2xl rounded-bl-sm px-5 py-3">
        <div className="flex items-center gap-1.5">
          <span className="typing-dot" />
          <span className="typing-dot" />
          <span className="typing-dot" />
        </div>
      </div>
    </div>
  );
}

function WelcomeScreen() {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center px-6">
      <div className="w-16 h-16 rounded-2xl bg-[var(--accent)]/10 flex items-center justify-center mb-6">
        <svg
          width="32"
          height="32"
          viewBox="0 0 32 32"
          fill="none"
        >
          <path
            d="M16 4C9.37 4 4 9.37 4 16s5.37 12 12 12 12-5.37 12-12S22.63 4 16 4z"
            fill="var(--accent)"
            opacity="0.15"
          />
          <path
            d="M20.5 13.5c0 1.38-1.12 2.5-2.5 2.5s-2.5-1.12-2.5-2.5S16.62 11 18 11s2.5 1.12 2.5 2.5zM13 19c0-1.66 1.34-3 3-3s3 1.34 3 3"
            stroke="var(--accent)"
            strokeWidth="1.5"
            strokeLinecap="round"
            fill="none"
          />
        </svg>
      </div>
      <h2 className="text-xl font-semibold text-[var(--text-primary)] mb-2">
        Pixie
      </h2>
      <p className="text-sm text-[var(--text-secondary)] max-w-sm leading-relaxed">
        Start a conversation with Claude by typing a message below.
        Use the sidebar to manage your chats.
      </p>
      <div className="flex flex-wrap justify-center gap-2 mt-8 max-w-md">
        {[
          "Explain how async/await works",
          "Write a Rust web server",
          "Help me debug my code",
          "Create a REST API",
        ].map((suggestion) => (
          <button
            key={suggestion}
            className="px-3 py-1.5 rounded-full text-xs border border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] transition-colors"
            disabled
          >
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function ChatView({ conversation, isGenerating }: ChatViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Previous message count — used to detect when the user sends a new turn.
  const prevCountRef = useRef(0);
  const [showJump, setShowJump] = useState(false);

  // Show a "jump to latest" button only when the user has manually scrolled up.
  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShowJump(distanceFromBottom >= 100);
  }, []);

  // Scroll to the bottom ONLY when a new message is added (i.e. the user just sent
  // a new turn). The assistant's streaming reply NEVER auto-scrolls, so you can
  // scroll freely and read at your own pace while it generates.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const count = conversation?.messages.length ?? 0;
    if (count > prevCountRef.current) {
      el.scrollTop = el.scrollHeight;
      setShowJump(false);
    }
    prevCountRef.current = count;
  }, [conversation?.messages]);

  const jumpToBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setShowJump(false);
  }, []);

  // No conversation selected
  if (!conversation) {
    return (
      <div className="flex-1 overflow-hidden">
        <WelcomeScreen />
      </div>
    );
  }

  // Empty conversation
  if (conversation.messages.length === 0) {
    return (
      <div className="flex-1 overflow-hidden">
        <WelcomeScreen />
      </div>
    );
  }

  const lastMessage = conversation.messages[conversation.messages.length - 1];

  return (
    <div className="flex-1 overflow-hidden relative">
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto px-4 py-6"
      >
        <div className="max-w-3xl mx-auto">
          {conversation.messages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} />
          ))}

          {/* Show typing indicator when the last message is a user message and we're generating */}
          {isGenerating &&
            lastMessage.role === "user" && (
              <TypingIndicator />
            )}
        </div>
      </div>

      {showJump && (
        <button
          className="jump-to-bottom"
          onClick={jumpToBottom}
          title="Scroll to latest"
          type="button"
        >
          ↓ Latest
        </button>
      )}
    </div>
  );
}
