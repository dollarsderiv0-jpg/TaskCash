"use client";

import * as React from "react";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/fields";
import { EmptyState } from "@/components/ui/misc";
import { ALL_HELP_TOPICS, HELP_GROUPS } from "@/lib/support/help-topics";

/**
 * Searchable help.
 *
 * Filtering happens in the browser over the full topic list, so it works
 * instantly and offline. Matching is deliberately forgiving: a user typing
 * "pay not show" should still reach the deposit answer, so words are matched
 * individually against the question, answer and keyword list.
 */
export function HelpSearch() {
  const [query, setQuery] = React.useState("");

  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2);

  const matches = React.useMemo(() => {
    if (terms.length === 0) return null;
    return ALL_HELP_TOPICS.filter((topic) => {
      const haystack = `${topic.question} ${topic.answer} ${topic.keywords.join(" ")} ${
        topic.group
      }`.toLowerCase();
      return terms.some((term) => haystack.includes(term));
    });
  }, [query]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section aria-labelledby="help-search-heading" className="space-y-4">
      <h2 id="help-search-heading" className="text-lg font-semibold tracking-tight">
        Search help
      </h2>

      <div className="relative">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Try “withdrawal”, “deposit not arrived”, “password”…"
          aria-label="Search help topics"
          className="pl-9 pr-9"
        />
        {query ? (
          <button
            type="button"
            onClick={() => setQuery("")}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-muted-foreground hover:bg-secondary"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        ) : null}
      </div>

      {matches ? (
        matches.length === 0 ? (
          <EmptyState
            icon={Search}
            title="No matching help articles"
            description={`Nothing matched “${query}”. Try a shorter word, or use the contact options below and we will answer directly.`}
            className="py-8"
          />
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground" role="status">
              {matches.length} article{matches.length === 1 ? "" : "s"} found.
            </p>
            {matches.map((topic) => (
              <Accordion key={topic.question} question={topic.question} answer={topic.answer} />
            ))}
          </div>
        )
      ) : (
        <div className="space-y-8">
          {HELP_GROUPS.map((group) => (
            <div key={group.group}>
              <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                {group.group}
              </h3>
              <div className="mt-3 space-y-3">
                {group.topics.map((topic) => (
                  <Accordion
                    key={topic.question}
                    question={topic.question}
                    answer={topic.answer}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function Accordion({ question, answer }: { question: string; answer: string }) {
  return (
    <details className="group rounded-2xl border border-border bg-card px-5 py-4 [&_summary::-webkit-details-marker]:hidden">
      <summary className="flex cursor-pointer items-center justify-between gap-4 text-sm font-semibold">
        {question}
        <span aria-hidden className="text-muted-foreground transition-transform group-open:rotate-45">
          +
        </span>
      </summary>
      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{answer}</p>
    </details>
  );
}
