import { createGraphQLError } from "graphql-yoga";
import { Kind, type ASTVisitor, type ValidationContext, type SelectionSetNode, type FragmentDefinitionNode } from "graphql";

/** Reject documents nested deeper than `max` (fragments followed, cycles cut). */
export function depthLimit(max: number) {
  return (context: ValidationContext): ASTVisitor => {
    const fragments = new Map<string, FragmentDefinitionNode>();
    for (const def of context.getDocument().definitions) if (def.kind === Kind.FRAGMENT_DEFINITION) fragments.set(def.name.value, def);
    const depth = (set: SelectionSetNode | undefined, level: number, seen: Set<string>): number => {
      if (!set) return level;
      let deepest = level;
      for (const sel of set.selections) {
        if (sel.kind === Kind.FIELD) {
          if (sel.name.value.startsWith("__")) continue;
          deepest = Math.max(deepest, depth(sel.selectionSet, level + 1, seen));
        } else if (sel.kind === Kind.INLINE_FRAGMENT) {
          deepest = Math.max(deepest, depth(sel.selectionSet, level, seen));
        } else if (sel.kind === Kind.FRAGMENT_SPREAD && !seen.has(sel.name.value)) {
          const fragment = fragments.get(sel.name.value);
          deepest = Math.max(deepest, depth(fragment?.selectionSet, level, new Set([...seen, sel.name.value])));
        }
      }
      return deepest;
    };
    return {
      OperationDefinition(node) {
        if (depth(node.selectionSet, 0, new Set()) > max) context.reportError(createGraphQLError(`query is deeper than ${max} levels`));
      },
    };
  };
}

/** Reject documents with more than `max` fields in total (alias amplification). */
export function fieldLimit(max: number) {
  return (context: ValidationContext): ASTVisitor => {
    let count = 0;
    return {
      Field() {
        count++;
        if (count === max + 1) context.reportError(createGraphQLError(`query selects more than ${max} fields`));
      },
    };
  };
}
