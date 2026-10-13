import { DatabaseSync } from "node:sqlite";
import { ensureMemoryIndexSchema } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { describe, expect, it, vi } from "vitest";
import { bm25RankToScore } from "./keyword-query.js";
import { searchKeyword } from "./manager-search.js";
import { insertKeywordFixture } from "./manager-search.test-support.js";
import { hasTrigramTokenizerForTests } from "./unicode-query.test-support.js";

type Tokenizer = "unicode61" | "trigram";
type Document = { id: string; text: string; source?: "memory" | "sessions" };
type SearchOptions = Partial<Pick<Parameters<typeof searchKeyword>[0], "limit" | "sourceFilter">>;

const hasTrigram = hasTrigramTokenizerForTests();

async function withSearch(
  ftsTokenizer: Tokenizer,
  documents: Document[],
  run: (
    search: (query: string, options?: SearchOptions) => ReturnType<typeof searchKeyword>,
    db: DatabaseSync,
  ) => Promise<void>,
) {
  const db = new DatabaseSync(":memory:");
  try {
    const schema = ensureMemoryIndexSchema({
      db,
      cacheEnabled: false,
      ftsEnabled: true,
      ftsTokenizer,
    });
    expect(schema.ftsAvailable).toBe(true);
    for (const document of documents) {
      insertKeywordFixture(db, {
        ...document,
        path: `memory/${document.id}.md`,
        model: "fts-only",
        endLine: 1,
      });
    }
    await run(
      (query, options = {}) =>
        searchKeyword({
          db,
          ftsTable: "memory_index_chunks_fts",
          ftsTokenizer,
          query,
          limit: 10,
          snippetMaxChars: 200,
          sourceFilter: { sql: "", params: [] },
          ...options,
        }),
      db,
    );
  } finally {
    db.close();
  }
}

const forms = ["NFC", "NFD"] as const;

describe("memory keyword query Unicode forms", () => {
  it.for([{ tokenizer: "unicode61" as const, word: "Μαΐου", stored: "NFD" as const }])(
    "matches $stored $word text with either query form using $tokenizer",
    async ({ tokenizer, word, stored }) => {
      const text = `${word} weather`.normalize(stored);
      await withSearch(
        tokenizer,
        [
          { id: "city", text },
          { id: "control", text: "quartz handbook" },
        ],
        async (search) => {
          for (const query of forms) {
            expect((await search(word.normalize(query))).map((hit) => hit.id)).toEqual(["city"]);
          }
        },
      );
    },
  );

  it.for(["re\u0341sume\u0301"])(
    "retains canonical alternatives for separator mark query %s",
    async (query) => {
      await withSearch(
        "unicode61",
        [
          { id: "canonical", text: query.normalize("NFC") },
          { id: "control", text: "quartz handbook" },
        ],
        async (search) => {
          expect((await search(query)).map((hit) => hit.id)).toEqual(["canonical"]);
        },
      );
    },
  );

  it.skipIf(!hasTrigram)("keeps short canonical trigram terms in substring fallback", async () => {
    await withSearch(
      "trigram",
      [
        { id: "accented", text: "fé noir".normalize("NFD") },
        { id: "plain", text: "fe noir" },
      ],
      async (search) => {
        for (const form of forms) {
          const hits = await search("fé".normalize(form));
          expect(hits.map((hit) => hit.id)).toEqual(["accented"]);
          expect(hits[0]?.textScore).toBe(0);
          expect((await search("fé noir".normalize(form))).map((hit) => hit.id)).toEqual([
            "accented",
          ]);
        }
        expect(await search("\u0308 !!!")).toEqual([]);
      },
    );
  });

  it.for(["unicode61"] as const)(
    "preserves scoped ranked limits for canonical %s queries",
    async (tokenizer) => {
      const documents: Document[] = Array.from({ length: 64 }, (_, i) => ({
        id: `item-${i}`,
        text: "München weather".normalize(i % 3 === 0 ? "NFD" : "NFC"),
        source: i % 2 === 0 ? "memory" : "sessions",
      }));
      await withSearch(tokenizer, documents, async (search, db) => {
        let examined = 0;
        db.function("observe_candidate", () => {
          examined++;
          return 1;
        });
        const hits = await search("München".normalize("NFD"), {
          limit: 3,
          sourceFilter: {
            sql: " AND source = ? AND observe_candidate() = 1",
            params: ["sessions"],
          },
        });
        expect(hits).toHaveLength(3);
        expect(new Set(hits.map((hit) => hit.id)).size).toBe(3);
        expect(hits.every((hit) => hit.source === "sessions")).toBe(true);
        expect(examined).toBeLessThanOrEqual(6);
        expect(await search("München", { limit: 0 })).toEqual([]);
      });
    },
  );

  it.for([
    { tokenizer: "unicode61" as const, word: "München" },
    { tokenizer: "trigram" as const, word: "Kelvin" },
  ])(
    "does not double-count canonical $tokenizer $word phrases",
    async ({ tokenizer, word }, context) => {
      if (tokenizer === "trigram" && !hasTrigram) {
        context.skip("SQLite does not provide the optional trigram tokenizer");
      }
      await withSearch(
        tokenizer,
        [
          { id: "city", text: `${word} weather`.normalize("NFD") },
          { id: "control", text: "quartz handbook" },
        ],
        async (search, db) => {
          const literal = db
            .prepare(
              "SELECT bm25(memory_index_chunks_fts) AS rank FROM memory_index_chunks_fts WHERE memory_index_chunks_fts MATCH ?",
            )
            .get(`"${word.normalize("NFD")}"`) as { rank: number };
          for (const query of new Set([word, word.normalize("NFD")])) {
            const canonical = await search(query);
            expect(canonical.map((hit) => hit.id)).toEqual(["city"]);
            expect(canonical[0]?.textScore).toBe(bm25RankToScore(literal.rank));
            expect(await search(`${query} ${query}`)).toEqual(canonical);
          }
        },
      );
    },
  );

  it("preserves whole Unicode words in MATCH-error fallback", async () => {
    await withSearch(
      "unicode61",
      [
        { id: "city", text: "München weather" },
        { id: "split", text: "Mu nchen weather" },
      ],
      async (search, db) => {
        const prepare = vi.spyOn(db, "prepare").mockImplementationOnce(() => {
          throw new Error("FTS5 MATCH failed");
        });
        try {
          const hits = await search("München".normalize("NFD"));
          expect(hits.map((hit) => hit.id)).toEqual(["city"]);
          expect(hits[0]?.textScore).toBe(0);
        } finally {
          prepare.mockRestore();
        }
      },
    );
  });
});
