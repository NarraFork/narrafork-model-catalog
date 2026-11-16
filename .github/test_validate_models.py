"""Regression tests for catalog integrity; no external services required."""

import copy
import json
import pathlib
import tempfile
import unittest

from validate_models import entry, metadata, sources, unique_object, validate_catalog

SOURCE = {
    "label": "Fixture",
    "url": "https://example.com/model",
    "verifiedAt": "2026-11-16T00:00:00Z",
}
MODEL = {"id": "model-a", "name": "Model A", "status": "unverified", "metadata": {}, "variants": []}


class ValidationTests(unittest.TestCase):
    def test_valid_optional_metadata(self):
        metadata({"max_tokens": None, "input_cost_per_token": 0, "supports_vision": None})

    def test_prices_are_finite_nonnegative_numbers_not_booleans(self):
        for value in (-1, float("nan"), float("inf"), True, "1"):
            with self.subTest(value=value), self.assertRaises(AssertionError):
                metadata({"input_cost_per_token": value})

    def test_context_limits_are_positive_integers(self):
        for value in (0, -1, 1.5, True):
            with self.subTest(value=value), self.assertRaises(AssertionError):
                metadata({"context_window": value})

    def test_reasoning_default_must_be_declared(self):
        with self.assertRaises(AssertionError):
            metadata({"reasoning_effort_levels": ["low"], "default_reasoning_effort": "high"})

    def test_non_reasoning_model_cannot_declare_efforts(self):
        with self.assertRaises(AssertionError):
            metadata({"supports_reasoning": False, "reasoning_effort_levels": ["high"]})

    def test_modalities_cannot_repeat_or_contain_unknown_values(self):
        for value in (["text", "text"], ["pdf"]):
            with self.subTest(value=value), self.assertRaises(AssertionError):
                metadata({"supported_modalities": value})

    def test_boolean_controls_reject_numbers(self):
        with self.assertRaises(AssertionError):
            metadata({"can_disable_reasoning": 1})

    def test_sources_need_url_and_timezone(self):
        sources([SOURCE])
        for patch in ({"url": "example.com"}, {"verifiedAt": "2026-11-16"}, {"fields": []}):
            with self.subTest(patch=patch), self.assertRaises(AssertionError):
                sources([{**SOURCE, **patch}])

    def test_duplicate_json_keys_are_rejected(self):
        with self.assertRaises(AssertionError):
            json.loads('{"id":"a","id":"b"}', object_pairs_hook=unique_object)

    def test_alias_cannot_shadow_canonical_id(self):
        matches = {}
        entry(MODEL, "", matches)
        other = {**MODEL, "id": "model-b", "matches": {"aliases": ["model-a"]}}
        with self.assertRaises(AssertionError):
            entry(other, "", matches)

    def test_provider_scopes_are_independent(self):
        matches = {}
        entry(MODEL, "provider-a", matches)
        entry({**MODEL, "id": "variant", "upstreamModelIds": ["model-a"]}, "provider-b", matches)

    def test_verified_entry_requires_sources(self):
        with self.assertRaises(AssertionError):
            entry({**MODEL, "status": "verified"}, "", {})
        entry({**MODEL, "status": "verified", "sources": [SOURCE]}, "", {})

    def test_source_fields_must_reference_recorded_values(self):
        model = {**MODEL, "sources": [{**SOURCE, "fields": ["metadata.input_cost_per_token"]}]}
        with self.assertRaisesRegex(AssertionError, "Source references missing field"):
            entry(model, "", {})
        model["metadata"] = {"input_cost_per_token": 1e-6}
        entry(model, "", {})

    def test_legacy_reasoning_source_vocabulary(self):
        model = {**MODEL, "metadata": {"supports_reasoning": True}, "sources": [{**SOURCE, "fields": ["reasoning"]}]}
        entry(model, "", {})

    def test_catalog_and_nested_variants(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "model-a.json"
            model = copy.deepcopy(MODEL)
            model["variants"] = [{**MODEL, "id": "model-a@provider", "providerKey": "provider", "upstreamModelIds": ["model-a"]}]
            path.write_text(json.dumps(model), encoding="utf-8")
            self.assertEqual(validate_catalog(directory), (1, 1))
            model["id"] = "wrong-filename"
            path.write_text(json.dumps(model), encoding="utf-8")
            with self.assertRaisesRegex(AssertionError, "ID must match filename"):
                validate_catalog(directory)


class CatalogRegressionTests(unittest.TestCase):
    @staticmethod
    def model(model_id):
        path = pathlib.Path(__file__).resolve().parents[1] / "models" / f"{model_id}.json"
        return json.loads(path.read_text(encoding="utf-8"))

    def test_new_model_candidates_have_cards(self):
        for model_id in (
            "gemini-4-hydrogen", "gemini-4-carbon",
            "claude-fable-5-1", "claude-mythos-5-1", "claude-fable-5-2", "claude-mythos-5-2",
            "minimax-m3.1-flash", "mimo-v2.6-flash", "mimo-v2.6-pro",
            "qwen3.8-max", "qwen3.8-flash", "gpt-image-2.6-flare", "gpt-image-2.6-sunburst",
            "gpt-6-rosalind", "gpt-6-cyber", "gpt-6-astra-law",
        ):
            with self.subTest(model=model_id):
                self.assertEqual(self.model(model_id)["id"], model_id)

    def test_composer_is_not_a_grok_build_alias(self):
        self.assertNotIn("composer-2.5", self.model("grok-build-0.1").get("matches", {}).get("aliases", []))

    def test_multi_agent_tools_do_not_inherit_chat_capabilities(self):
        model = self.model("grok-4.20-multi-agent")
        self.assertIs(model["metadata"]["supports_function_calling"], False)
        self.assertEqual(model["metadata"]["supported_endpoints"], ["/v1/responses"])
        self.assertNotIn(model["id"], self.model("grok-4.3").get("matches", {}).get("aliases", []))

    def test_cursor_long_context_threshold_is_provider_specific(self):
        model = self.model("grok-4.7")
        cursor = next(v for v in model["variants"] if v["providerKey"] == "cursor")
        self.assertEqual(cursor["metadata"]["long_context_input_token_threshold"], 256000)
        self.assertNotIn("input_cost_per_token_above_200k_tokens", cursor["metadata"])

    def test_deepseek_version_ids_remain_aliases(self):
        aliases = self.model("deepseek-flash")["matches"]["aliases"]
        self.assertIn("deepseek-v4.1-flash", aliases)
        self.assertIn("deepseek-v4.1-flash-1017", aliases)


if __name__ == "__main__":
    unittest.main()
