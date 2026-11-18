"""Validate the catalog without network access or third-party dependencies."""

import datetime
import json
import math
import pathlib
import re
from urllib.parse import urlsplit

EFFORTS = {"none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"}
MODALITIES = {"text", "image", "audio", "video"}


def unique_object(pairs):
    value = {}
    for key, item in pairs:
        assert key not in value, f"Duplicate JSON key: {key}"
        value[key] = item
    return value


def strings(value, nonempty=False):
    assert isinstance(value, list), "Expected string array"
    assert all(isinstance(x, str) and x.strip() for x in value), "Expected nonempty strings"
    assert len(value) == len(set(value)), "Duplicate array entries"
    assert not nonempty or value, "Expected nonempty array"


def nonnegative(value, key):
    assert value is None or (
        type(value) in (int, float) and math.isfinite(value) and value >= 0
    ), f"Invalid nonnegative number: {key}"


def metadata(value):
    assert isinstance(value, dict), "Expected metadata object"
    for key, item in value.items():
        if key in (
            "context_window", "max_input_tokens", "max_output_tokens", "max_tokens",
            "long_context_input_token_threshold",
        ):
            assert item is None or (type(item) is int and item > 0), key
        if key.startswith(("input_cost_", "output_cost_", "cache_read_", "cache_creation_")):
            nonnegative(item, key)
        if key.startswith("supports_") or key == "can_disable_reasoning":
            assert item is None or type(item) is bool, key
    levels = value.get("reasoning_effort_levels")
    if levels is not None:
        strings(levels, nonempty=True)
        assert set(levels) <= EFFORTS, "Invalid reasoning effort"
    default = value.get("default_reasoning_effort")
    if default is not None:
        assert isinstance(default, str) and default in EFFORTS, "Invalid reasoning default"
        assert levels is None or default in levels, "Default effort missing from levels"
    if value.get("supports_reasoning") is False:
        assert not levels and default is None, "Non-reasoning model declares reasoning controls"
    for key in ("supported_modalities", "supported_output_modalities"):
        if value.get(key) is not None:
            strings(value[key])
            assert set(value[key]) <= MODALITIES, key
    if value.get("supported_endpoints") is not None:
        strings(value["supported_endpoints"], nonempty=True)
        assert all(x.startswith("/") for x in value["supported_endpoints"]), "Invalid endpoint"


def sources(value):
    assert isinstance(value, list), "Invalid sources"
    for source in value:
        assert isinstance(source, dict), "Invalid source"
        for key in ("label", "url", "verifiedAt"):
            assert isinstance(source.get(key), str) and source[key].strip(), f"Invalid source {key}"
        url = urlsplit(source["url"])
        assert url.scheme in ("http", "https") and url.netloc, "Invalid source URL"
        date = datetime.datetime.fromisoformat(source["verifiedAt"].replace("Z", "+00:00"))
        assert date.tzinfo is not None, "Source date must include timezone"
        if "fields" in source:
            strings(source["fields"], nonempty=True)


def source_field_exists(value, field):
    # Older catalog sources use the consumer-facing reasoning vocabulary.
    field = {
        "reasoning": "metadata.supports_reasoning",
        "reasoning.levels": "metadata.reasoning_effort_levels",
        "reasoning.defaultLevel": "metadata.default_reasoning_effort",
        "reasoning.canDisable": "metadata.can_disable_reasoning",
    }.get(field, field)
    if field in value.get("metadata", {}):
        return True
    current = value
    for part in field.split("."):
        if not isinstance(current, dict) or part not in current:
            return False
        current = current[part]
    return True


def entry(value, scope, matches):
    assert isinstance(value, dict), "Expected entry object"
    for key in ("id", "name"):
        assert isinstance(value.get(key), str) and value[key].strip(), key
    assert value.get("status") in ("verified", "unverified"), "Invalid status"
    if "family" in value:
        assert isinstance(value["family"], str) and value["family"].strip(), "Invalid family"
    rules = value.get("matches", {})
    assert isinstance(rules, dict), "Invalid matches"
    assert not set(rules) - {"ids", "aliases", "prefixes", "volatileSuffixes"}, "Unknown match field"
    for key in ("ids", "aliases", "prefixes"):
        strings(rules.get(key, []))
    if "volatileSuffixes" in rules:
        assert type(rules["volatileSuffixes"]) is bool, "Invalid volatileSuffixes"
    # IDs and aliases occupy the same lookup namespace. Checking them separately
    # would miss an alias shadowing another model's canonical ID.
    for kind, keys in (
        ("exact", [value["id"]] + value.get("upstreamModelIds", [])
         + rules.get("ids", []) + rules.get("aliases", [])),
        ("prefix", rules.get("prefixes", [])),
    ):
        for key in keys:
            token = (scope, kind, key)
            assert token not in matches or matches[token] == value["id"], f"Ambiguous match: {token}"
            matches[token] = value["id"]
    sources(value.get("sources", []))
    assert value["status"] != "verified" or value.get("sources"), "Verified entry requires sources"
    metadata(value["metadata"])
    for source in value.get("sources", []):
        for field in source.get("fields", []):
            assert source_field_exists(value, field), f"Source references missing field: {field}"


def validate_catalog(directory):
    files = sorted(pathlib.Path(directory).glob("*.json"))
    assert files, "models/ must not be empty"
    variants = set()
    matches = {}
    for path in files:
        try:
            model = json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=unique_object)
            assert isinstance(model, dict) and model["id"] == path.stem, "ID must match filename"
            entry(model, "", matches)
            assert re.fullmatch(r"[a-z0-9][a-z0-9._-]*", model["id"]), "Invalid model ID"
            assert isinstance(model["variants"], list), "Expected variants array"
            for variant in model["variants"]:
                assert isinstance(variant, dict), "Expected variant object"
                assert "modelId" not in variant, "Containing file defines the parent model"
                assert isinstance(variant.get("providerKey"), str) and variant["providerKey"].strip(), "Invalid providerKey"
                strings(variant.get("upstreamModelIds"), nonempty=True)
                entry(variant, variant["providerKey"], matches)
                assert variant["id"] not in variants, f"Duplicate variant: {variant['id']}"
                variants.add(variant["id"])
        except (AssertionError, KeyError, TypeError, ValueError) as error:
            raise AssertionError(f"{path}: {error}") from error
    return len(files), len(variants)


if __name__ == "__main__":
    assert not list(pathlib.Path(".").glob("*.json")), "No root-level JSON bundles or configuration"
    models, variants = validate_catalog("models")
    print(f"{models} models, {variants} nested variants")
