import { Command } from "commander";
import { ensureServer, getClientV2 } from "../client.js";
import { formatJSON } from "../format.js";

interface Model {
  id: string;
  name: string;
  status: "alpha" | "beta" | "deprecated" | "active";
  limit: { context: number; output: number };
  variants?: { [key: string]: { [key: string]: unknown } };
}

interface Provider {
  id: string;
  name: string;
  source?: string;
  key?: string;
  env?: string[];
  options?: { apiKey?: string; [key: string]: unknown };
  models: { [id: string]: Model };
}

interface ModelMatch {
  provider: Provider;
  model: Model;
}

export function modelsCommand(): Command {
  return new Command("models")
    .description(
      "List providers, models, and variants from /config/providers (uses v2 SDK)"
    )
    .argument(
      "[selector]",
      "Filter: <provider> for that provider's models, or <provider>/<model> for detail view"
    )
    .option("-j, --json", "Output as JSON")
    .option(
      "--enabled",
      "Only show providers that have credentials present"
    )
    .option(
      "--grep <text>",
      "Search models by provider/model ID or display name; prints full provider/model IDs"
    )
    .action(async (selector: string | undefined, opts) => {
      // ensureServer uses v1 just for the health check; the actual call is v2.
      await ensureServer();
      const clientV2 = getClientV2();

      const result = await clientV2.config.providers();
      if (!result.data) {
        console.error("Failed to load providers.");
        process.exit(1);
      }

      let providers = (result.data.providers ?? []) as Provider[];

      if (opts.enabled) {
        providers = providers.filter(hasCredentials);
      }

      let providerFilter: string | undefined;
      let modelFilter: string | undefined;
      if (selector) {
        const slash = selector.indexOf("/");
        if (slash >= 0) {
          providerFilter = selector.slice(0, slash);
          modelFilter = selector.slice(slash + 1);
        } else {
          providerFilter = selector;
        }
      }

      const filtered = providerFilter
        ? providers.filter((p) => p.id === providerFilter)
        : providers;

      if (providerFilter && filtered.length === 0) {
        console.error(`Provider '${providerFilter}' not found.`);
        process.exit(1);
      }

      if (opts.grep) {
        const matches = findModelMatches(filtered, opts.grep);
        if (matches.length === 0) {
          console.error(`No models matched '${opts.grep}'.`);
          process.exit(1);
        }

        if (opts.json) {
          console.log(
            formatJSON({
              models: matches.map(({ provider, model }) => ({
                providerID: provider.id,
                id: model.id,
                fullID: `${provider.id}/${model.id}`,
                name: model.name,
                status: model.status,
                variants: model.variants ? Object.keys(model.variants) : [],
              })),
              default: result.data.default,
            })
          );
          return;
        }

        for (const { provider, model } of matches) {
          printModelLine(provider.id, model);
        }
        return;
      }

      if (modelFilter) {
        const provider = filtered[0]!;
        const model = provider.models[modelFilter];
        if (!model) {
          console.error(
            `Model '${modelFilter}' not found under provider '${provider.id}'.`
          );
          process.exit(1);
        }
        if (opts.json) {
          console.log(formatJSON(model));
          return;
        }
        printModelDetail(provider.id, model);
        return;
      }

      if (opts.json) {
        if (providerFilter) {
          console.log(formatJSON(filtered[0]));
        } else {
          console.log(formatJSON({ providers: filtered, default: result.data.default }));
        }
        return;
      }

      for (const provider of filtered) {
        const models = Object.values(provider.models);
        if (models.length === 0) continue;
        console.log(`${provider.id} (${provider.name})`);
        for (const model of models) {
          printModelLine("", model, "  ");
        }
        console.log();
      }
    });
}

function hasCredentials(provider: Provider): boolean {
  return !!provider.key || !!provider.options?.apiKey;
}

function findModelMatches(providers: Provider[], grep: string): ModelMatch[] {
  const query = grep.toLowerCase();
  const matches: ModelMatch[] = [];

  for (const provider of providers) {
    for (const model of Object.values(provider.models)) {
      const fullID = `${provider.id}/${model.id}`;
      const haystack = [fullID, model.id, model.name].join("\n").toLowerCase();
      if (haystack.includes(query)) {
        matches.push({ provider, model });
      }
    }
  }

  return matches;
}

function printModelLine(providerId: string, model: Model, indent = ""): void {
  const variantNames = model.variants ? Object.keys(model.variants) : [];
  const variantStr =
    variantNames.length > 0 ? `  variants: ${variantNames.join(", ")}` : "";
  const statusStr = model.status === "active" ? "" : ` [${model.status}]`;
  const id = providerId ? `${providerId}/${model.id}` : model.id;
  console.log(`${indent}${id}${statusStr}${variantStr}`);
}

function printModelDetail(providerId: string, model: Model): void {
  console.log(`${providerId}/${model.id}`);
  console.log(`  Name:    ${model.name}`);
  console.log(`  Status:  ${model.status}`);
  console.log(`  Context: ${model.limit.context}`);
  console.log(`  Output:  ${model.limit.output}`);
  if (model.variants) {
    const names = Object.keys(model.variants);
    if (names.length > 0) {
      console.log(`  Variants:`);
      for (const name of names) {
        console.log(`    - ${name}`);
      }
    }
  }
}
