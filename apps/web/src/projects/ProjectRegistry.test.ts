import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getAllProjects,
  getFeaturedProjects,
  getProjectById,
  getProjectBySlug,
  getProjectsByCategory,
  getUsedCategories,
  searchProjects,
  validateProjects,
} from "./ProjectRegistry.ts";
import { PROJECTS } from "./projectData.ts";
import type { Project } from "./ProjectTypes.ts";

// CORE-005 § 31. The fixture dataset itself is already validated at
// module load (ProjectRegistry.ts's top-level `validateProjects(PROJECTS)`
// call) — if that throws, every test in this file fails immediately,
// which is itself a form of coverage for the real registry's integrity.

test("fixture dataset has at least 5 projects (task brief § 8)", () => {
  assert.ok(PROJECTS.length >= 5);
});

// Test 1
test("Test 1: project IDs are unique", () => {
  const ids = PROJECTS.map((project) => project.id);
  assert.equal(new Set(ids).size, ids.length);
});

// Test 2
test("Test 2: project slugs are unique", () => {
  const slugs = PROJECTS.map((project) => project.slug);
  assert.equal(new Set(slugs).size, slugs.length);
});

// Test 3
test("Test 3: getProjectById works", () => {
  const sample = PROJECTS[0]!;
  assert.deepEqual(getProjectById(sample.id), sample);
  assert.equal(getProjectById("does-not-exist"), undefined);
});

// Test 4
test("Test 4: getProjectBySlug works", () => {
  const sample = PROJECTS[0]!;
  assert.deepEqual(getProjectBySlug(sample.slug), sample);
  assert.equal(getProjectBySlug("does-not-exist"), undefined);
});

// Test 5
test("Test 5: featured filtering works", () => {
  const featured = getFeaturedProjects();
  assert.ok(featured.length > 0, "fixture data should include at least one featured project");
  assert.ok(featured.every((project) => project.featured === true));
  assert.ok(featured.length < getAllProjects().length, "not every fixture project should be featured");
});

// Test 6
test("Test 6: category filtering works", () => {
  const category = PROJECTS[0]!.category;
  const results = getProjectsByCategory(category);
  assert.ok(results.length > 0);
  assert.ok(results.every((project) => project.category === category));
});

// Test 7
test("Test 7: search matches name", () => {
  const sample = PROJECTS[0]!;
  const results = searchProjects(sample.name.slice(0, 4));
  assert.ok(results.some((project) => project.id === sample.id));
});

// Test 8
test("Test 8: search matches tags", () => {
  const sampleWithTag = PROJECTS.find((project) => project.tags.length > 0)!;
  const tag = sampleWithTag.tags[0]!;
  const results = searchProjects(tag);
  assert.ok(results.some((project) => project.id === sampleWithTag.id));
});

// Test 9
test("Test 9: search is case-insensitive", () => {
  const sample = PROJECTS[0]!;
  const lower = searchProjects(sample.name.toLowerCase());
  const upper = searchProjects(sample.name.toUpperCase());
  assert.ok(lower.some((project) => project.id === sample.id));
  assert.ok(upper.some((project) => project.id === sample.id));
});

test("search with an empty/whitespace query returns everything in scope", () => {
  assert.deepEqual(searchProjects(""), PROJECTS);
  assert.deepEqual(searchProjects("   "), PROJECTS);
});

test("search composes with an already-filtered scope (category + search together)", () => {
  const category = PROJECTS[0]!.category;
  const byCategory = getProjectsByCategory(category);
  const combined = searchProjects("this-will-match-nothing-xyz", byCategory);
  assert.equal(combined.length, 0);
});

test("getUsedCategories only returns categories actually present in the registry, with no duplicates", () => {
  const used = getUsedCategories();
  assert.equal(new Set(used).size, used.length);
  for (const category of used) {
    assert.ok(PROJECTS.some((project) => project.category === category));
  }
});

// --- validateProjects() — data integrity, task brief § 30 -----------------

function baseProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "p1",
    slug: "p1",
    name: "Sample",
    shortDescription: "short",
    description: "long",
    category: "other",
    status: "active",
    tags: [],
    featured: false,
    ...overrides,
  };
}

test("validateProjects rejects a duplicate id", () => {
  assert.throws(() => validateProjects([baseProject({ id: "dup", slug: "a" }), baseProject({ id: "dup", slug: "b" })]), /duplicate project id/);
});

test("validateProjects rejects a duplicate slug", () => {
  assert.throws(() => validateProjects([baseProject({ id: "a", slug: "dup" }), baseProject({ id: "b", slug: "dup" })]), /duplicate project slug/);
});

test("validateProjects rejects an empty name", () => {
  assert.throws(() => validateProjects([baseProject({ name: "   " })]), /empty name/);
});

test("validateProjects rejects an invalid status", () => {
  assert.throws(() => validateProjects([baseProject({ status: "launched" as Project["status"] })]), /invalid status/);
});

test("validateProjects rejects an invalid category", () => {
  assert.throws(() => validateProjects([baseProject({ category: "gaming" as Project["category"] })]), /invalid category/);
});

test("validateProjects rejects a non-string tag", () => {
  assert.throws(() => validateProjects([baseProject({ tags: [123 as unknown as string] })]), /non-string tag/);
});

test("validateProjects rejects an unsafe URL field", () => {
  assert.throws(() => validateProjects([baseProject({ websiteUrl: "javascript:alert(1)" })]), /unsafe websiteUrl/);
});

test("validateProjects accepts a minimal valid project with no optional fields", () => {
  assert.doesNotThrow(() => validateProjects([baseProject()]));
});
