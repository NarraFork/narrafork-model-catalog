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

    def test_explicit_total_context_rejects_larger_output(self):
        with self.assertRaises(AssertionError):
            metadata({"context_window": 131072, "max_output_tokens": 260640})
        metadata({"max_input_tokens": 131072, "max_output_tokens": 260640})
        metadata({"context_window": None, "max_output_tokens": 260640})

    def test_reasoning_default_must_be_declared(self):
        with self.assertRaises(AssertionError):
            metadata({"reasoning_effort_levels": ["low"], "default_reasoning_effort": "high"})

    def test_client_presets_and_unknown_values_are_not_model_efforts(self):
        for effort in ("ultra", "unlimited"):
            with self.subTest(effort=effort), self.assertRaisesRegex(AssertionError, "Invalid reasoning effort"):
                metadata({"reasoning_effort_levels": ["low", effort]})
            with self.subTest(effort=effort), self.assertRaisesRegex(AssertionError, "Invalid reasoning default"):
                metadata({"default_reasoning_effort": effort})

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
        for patch in ({"url": "example.com"}, {"verifiedAt": "2026-11-16"}):
            with self.subTest(patch=patch), self.assertRaises(AssertionError):
                sources([{**SOURCE, **patch}])

    def test_consumer_only_source_fields_are_rejected(self):
        for patch in ({"notes": "aggregate evidence"}, {"fields": ["limits"]}):
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

    def test_consumer_only_entry_fields_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "model-a.json"
            model = copy.deepcopy(MODEL)
            model["upstreamModelIds"] = ["Model-A"]
            path.write_text(json.dumps(model), encoding="utf-8")
            with self.assertRaisesRegex(AssertionError, "matches.aliases"):
                validate_catalog(directory)
            del model["upstreamModelIds"]
            model["variants"] = [{**MODEL, "id": "model-a@provider", "providerKey": "provider", "upstreamModelIds": ["model-a"], "family": "test", "notes": "provider-only"}]
            path.write_text(json.dumps(model), encoding="utf-8")
            with self.assertRaisesRegex(AssertionError, "Variant family"):
                validate_catalog(directory)


class CatalogRegressionTests(unittest.TestCase):
    @staticmethod
    def model(model_id):
        path = pathlib.Path(__file__).resolve().parents[1] / "models" / f"{model_id}.json"
        return json.loads(path.read_text(encoding="utf-8"))

    def test_gemini_omni_vertex_total_context_is_explicitly_unknown(self):
        card = self.model("gemini-omni-1.2-flash")
        vertex = next(v for v in card["variants"] if v["providerKey"] == "vertex_ai")
        self.assertIsNone(vertex["metadata"]["max_input_tokens"])
        self.assertEqual(vertex["metadata"]["max_output_tokens"], 260640)
        self.assertNotIn("context_window", vertex["metadata"])
        metadata(vertex["metadata"])

    def test_catalog_stays_inside_the_consumer_shared_schema(self):
        for path in pathlib.Path(__file__).resolve().parents[1].glob("models/*.json"):
            with self.subTest(path=path.name):
                model = json.loads(path.read_text(encoding="utf-8"))
                self.assertNotIn("upstreamModelIds", model)
                for source in model.get("sources", []):
                    self.assertNotIn("notes", source)
                    self.assertNotIn("fields", source)
                for variant in model.get("variants", []):
                    self.assertNotIn("family", variant)
                    self.assertNotIn("notes", variant)
                    for source in variant.get("sources", []):
                        self.assertNotIn("notes", source)
                        self.assertNotIn("fields", source)

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

    def test_deepseek_time_based_prices_are_not_unconditional(self):
        for model_id in (
            "deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp", "deepseek-v4-pro",
        ):
            with self.subTest(model=model_id):
                info = self.model(model_id)["metadata"]
                for key in (
                    "input_cost_per_token", "output_cost_per_token", "cache_read_input_token_cost",
                ):
                    self.assertNotIn(key, info)
                    self.assertGreater(info[key + "_peak"], info[key + "_off_peak"])
                    self.assertEqual(info[key + "_off_peak"], info["off_peak_pricing"][key])

    def test_gpt62_native_cards_have_sourced_limits_and_distinct_prices(self):
        for suffix, input_price, cached_price, output_price in (
            ("astra", 8e-6, 4e-7, 40e-6),
            ("sol", 2e-6, 1e-7, 10e-6),
            ("astra-law", 8e-6, 4e-7, 40e-6),
        ):
            with self.subTest(model=suffix):
                card = self.model("gpt-6.2-" + suffix)
                info = card["metadata"]
                self.assertEqual(card["status"], "unverified")
                self.assertEqual(info["max_input_tokens"], 922000)
                self.assertEqual(info["max_output_tokens"], 128000)
                self.assertEqual(info["input_cost_per_token"], input_price)
                self.assertEqual(info["cache_read_input_token_cost"], cached_price)
                self.assertEqual(info["output_cost_per_token"], output_price)
                self.assertNotIn("default_reasoning_effort", info)
                if suffix != "astra-law":
                    self.assertEqual(info["context_window"], 1050000)
                    self.assertEqual(info["long_context_input_token_threshold"], 272000)

    def test_gpt62_codex_discovery_is_not_native_api_metadata(self):
        for suffix, default_window in (("astra", 272000), ("sol", 500000)):
            with self.subTest(model=suffix):
                card = self.model("gpt-6.2-" + suffix)
                codex = next(v for v in card["variants"] if v["providerKey"] == "codex")
                effective = {**card["metadata"], **codex["metadata"]}
                self.assertEqual(effective["context_window"], default_window)
                self.assertEqual(effective["max_context_window"], 872000)
                self.assertEqual(effective["default_reasoning_effort"], "low")
                self.assertEqual(effective["reasoning_effort_levels"], ["low", "medium", "high", "xhigh", "max"])
                self.assertNotIn("reasoning_effort_levels", card["metadata"])
                self.assertEqual("audio" in effective["supported_modalities"], suffix == "sol")
                self.assertNotIn("audio", card["metadata"]["supported_modalities"])

    def test_gpt62_channel_rates_and_capabilities_remain_scoped(self):
        for suffix in ("astra", "sol"):
            with self.subTest(model=suffix):
                card = self.model("gpt-6.2-" + suffix)
                azure = next(v for v in card["variants"] if v["id"] == card["id"] + "@azure")
                azure_effective = {**card["metadata"], **azure["metadata"]}
                self.assertEqual(azure_effective["supports_max_reasoning_effort"], suffix == "sol")
                self.assertIs(card["metadata"]["supports_max_reasoning_effort"], True)
                copilot = next(v for v in card["variants"] if v["providerKey"] == "github-copilot")
                copilot_effective = {**card["metadata"], **copilot["metadata"]}
                self.assertEqual(copilot_effective["supported_endpoints"], ["/v1/responses"])
                chatgpt = next(v for v in card["variants"] if v["providerKey"] == "chatgpt")
                self.assertNotIn("input_cost_per_token", chatgpt["metadata"])
                self.assertNotIn("max_input_tokens", next(v for v in card["variants"] if v["providerKey"] == "codex")["metadata"])

    def test_gpt62_bedrock_protocols_keep_separate_metadata(self):
        for suffix in ("astra", "sol"):
            with self.subTest(model=suffix):
                card = self.model("gpt-6.2-" + suffix)
                mantle = next(v for v in card["variants"] if v["providerKey"] == "bedrock-mantle")
                converse = next(v for v in card["variants"] if v["id"] == card["id"] + "@bedrock-openai")
                mantle_effective = {**card["metadata"], **mantle["metadata"]}
                converse_effective = {**card["metadata"], **converse["metadata"]}
                self.assertEqual(mantle_effective["litellm_provider"], "bedrock_mantle")
                self.assertEqual(converse_effective["litellm_provider"], "bedrock_converse")
                self.assertAlmostEqual(mantle_effective["input_cost_per_token"], card["metadata"]["input_cost_per_token"] * 1.1)
                self.assertEqual(converse_effective["input_cost_per_token"], card["metadata"]["input_cost_per_token"])

    def test_gpt62_ultrafast_prices_are_time_limited(self):
        for suffix in ("astra", "sol"):
            with self.subTest(model=suffix):
                info = self.model("gpt-6.2-" + suffix)["metadata"]
                self.assertEqual(info["ultrafast_promotion_end_at"], "2027-03-01T08:00:00Z")
                self.assertEqual(info["ultrafast_multiplier_during_promotion"], 3)
                self.assertEqual(info["ultrafast_multiplier_after_promotion"], 6)
                for price in ("input_cost_per_token", "output_cost_per_token", "cache_read_input_token_cost", "cache_creation_input_token_cost"):
                    self.assertAlmostEqual(info[price + "_ultrafast"], info[price] * 3)
        self.assertNotIn("ultrafast_promotion_end_at", self.model("gpt-6.2-astra-law")["metadata"])

    def test_gpt62_does_not_retarget_existing_latest_aliases(self):
        for model, alias in (("gpt-6-astra", "gpt-astra-latest"), ("gpt-6.1-sol", "gpt-sol-latest")):
            self.assertIn(alias, self.model(model)["matches"]["aliases"])
            for new_model in ("gpt-6.2-astra", "gpt-6.2-sol", "gpt-6.2-astra-law"):
                self.assertNotIn(alias, self.model(new_model).get("matches", {}).get("aliases", []))

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
