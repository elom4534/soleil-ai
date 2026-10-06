/**
 * ============================================================================
 * SOLEIL AI — Tests de sécurité du toolkit du LLM
 * ============================================================================
 * Les outils sont strictement en lecture seule : aucun outil d'écriture ne
 * peut exister dans la boîte du LLM. 🔒 Aucune base, aucun réseau.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { TOOL_SCHEMAS, executeTool } from "../toolkit";

test("aucun outil d'écriture n'est exposé au LLM", () => {
  const names = TOOL_SCHEMAS.map((t) => t.function.name);
  for (const forbidden of ["delete", "drop", "truncate", "update", "create", "write", "exec", "sql"]) {
    assert.equal(
      names.some((n) => n.toLowerCase().includes(forbidden)),
      false,
      `l'outil ne doit pas contenir « ${forbidden} »`,
    );
  }
  assert.equal(names.includes("web_search"), true);
  assert.equal(names.includes("prediction"), true);
});

test("un outil inconnu est refusé proprement", async () => {
  const out = await executeTool("rm_rf", {}, { webUsed: 0, maxWeb: 2 });
  assert.match(out, /Outil inconnu/);
});

test("la borne de recherches web est appliquée", async () => {
  const out = await executeTool("web_search", { query: "test" }, { webUsed: 2, maxWeb: 2 });
  assert.match(out, /Limite de recherches web atteinte/);
});

test("chaque outil est déclaré avec une description et des paramètres", () => {
  for (const t of TOOL_SCHEMAS) {
    assert.ok(t.function.description.length > 20, `${t.function.name} : description suffisante`);
    assert.equal(t.function.parameters.type, "object");
  }
});
