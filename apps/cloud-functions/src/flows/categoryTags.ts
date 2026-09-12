// Shared category-tag policy for every recipe-authoring path (issue: tighten
// recipe categories). The librarian (authorRecipe) and URL-import
// (extractRecipeFromUrl) flows both end by asking the model to emit `tags`, so
// the rule lives here once — a single source of truth that cannot drift between
// the two prompts.
//
// Tags exist ONLY to power search and filtering on the recipe list. They must be
// high-level classifications of what KIND of dish this is (cuisine, course, dish
// form, dietary, character) — never the ingredients it contains, which are
// already searchable from the ingredient list and would just be redundant
// clutter. This block slots in as the `- tags:` bullet of both prompts' field
// lists, so it must start with `- tags:` and use matching two-space indentation.
//
// Only the PROMPT COPY lives here. What a tag becomes once it exists is
// `normaliseTags` in `@salt/domain` (issue #1054), because the recipe page
// applies the same rule to what a person types and is in an app this one cannot
// import. Nothing in `web-pwa` may see the prompt text below.
export const CATEGORY_TAG_RULES = `- tags: categories for search and filtering ONLY. Assign high-level classifications that describe what KIND of dish this is — the way a cook would filter a cookbook. Draw from these dimensions, using only the ones that clearly apply (a few accurate tags beat a long list):
  - cuisine / origin: e.g. italian, thai, mexican, middle-eastern, british
  - course / meal: e.g. breakfast, brunch, lunch, main, side-dish, dessert, snack
  - dish form: e.g. salad, soup, stew, curry, bake, traybake, stir-fry, roast
  - dietary: ONLY "vegetarian". Never emit any other dietary/free-from tag — no "vegan", "gluten-free", "dairy-free", "nut-free", "low-carb", "keto" etc. (we don't filter on those)
  - character / occasion: e.g. comfort-food, quick, healthy, spicy, budget, batch-cook, freezer-friendly
  NEVER use an ingredient as a tag (no "chicken", "beef", "tomato", "pasta", "garlic", "chorizo", "chocolate") — the ingredient list is already searchable, so ingredient tags are redundant. If the source keywords include ingredient names, drop them and keep only genuine categories. Short, lowercase, 1–3 words each. Empty array if nothing clearly applies.`;
