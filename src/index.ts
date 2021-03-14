// Forked from https://github.com/vercel/next.js/blob/574fe0b582d5cc1b13663121fd47a3d82deaaa17/packages/next/build/babel/plugins/next-ssg-transform.ts

import { PluginObj, NodePath, types as BabelTypes } from '@babel/core'

function getIdentifier(
  path: NodePath<
    | BabelTypes.FunctionDeclaration
    | BabelTypes.FunctionExpression
    | BabelTypes.ArrowFunctionExpression
  >,
): NodePath<BabelTypes.Identifier> | null {
  const parentPath = path.parentPath
  if (parentPath.type === 'VariableDeclarator') {
    const pp = parentPath as NodePath<BabelTypes.VariableDeclarator>
    const name = pp.get('id')
    return name.node.type === 'Identifier'
      ? (name as NodePath<BabelTypes.Identifier>)
      : null
  }

  if (parentPath.type === 'AssignmentExpression') {
    const pp = parentPath as NodePath<BabelTypes.AssignmentExpression>
    const name = pp.get('left')
    return name.node.type === 'Identifier'
      ? (name as NodePath<BabelTypes.Identifier>)
      : null
  }

  if (path.node.type === 'ArrowFunctionExpression') {
    return null
  }

  return path.node.id && path.node.id.type === 'Identifier'
    ? (path.get('id') as NodePath<BabelTypes.Identifier>)
    : null
}

function isIdentifierReferenced(
  ident: NodePath<BabelTypes.Identifier>,
): boolean {
  const b = ident.scope.getBinding(ident.node.name)
  if (b?.referenced) {
    // Functions can reference themselves, so we need to check if there's a
    // binding outside the function scope or not.
    if (b.path.type === 'FunctionDeclaration') {
      return !b.constantViolations
        .concat(b.referencePaths)
        // Check that every reference is contained within the function:
        .every((ref) => ref.findParent((p) => p === b.path))
    }

    return true
  }
  return false
}

const createMarkFunction = (state: PluginState) =>
  function markFunction(
    path: NodePath<
      | BabelTypes.FunctionDeclaration
      | BabelTypes.FunctionExpression
      | BabelTypes.ArrowFunctionExpression
    >,
  ) {
    const ident = getIdentifier(path)
    if (ident?.node && isIdentifierReferenced(ident)) {
      state.refs.add(ident)
    }
  }

const createMarkImport = (state: PluginState) =>
  function markImport(
    path: NodePath<
      | BabelTypes.ImportSpecifier
      | BabelTypes.ImportDefaultSpecifier
      | BabelTypes.ImportNamespaceSpecifier
    >,
  ) {
    const local = path.get('local')
    if (isIdentifierReferenced(local)) {
      state.refs.add(local)
    }
  }

type PluginState = {
  refs: Set<NodePath<BabelTypes.Identifier>>
  opts: PluginOpts
  removedNamedExports: Set<string>
}

export type PluginOpts = {
  namedExports?: string[]
  done?: (state: PluginState) => void
}

export default function babelPluginEliminator({
  types: t,
}: {
  types: typeof BabelTypes
}): PluginObj<PluginState> {
  return {
    visitor: {
      Program: {
        enter(path, state) {
          state.refs = new Set()
          state.removedNamedExports = new Set()

          const namedExports = state.opts.namedExports || []

          const markImport = createMarkImport(state)
          const markFunction = createMarkFunction(state)

          // Keep variables that're referenced
          path.traverse({
            // No idea why the second argument is always undefine
            // It should have been `state`
            VariableDeclarator(variablePath) {
              if (variablePath.node.id.type === 'Identifier') {
                const local = variablePath.get(
                  'id',
                ) as NodePath<BabelTypes.Identifier>
                if (isIdentifierReferenced(local)) {
                  state.refs.add(local)
                }
              } else if (variablePath.node.id.type === 'ObjectPattern') {
                const pattern = variablePath.get(
                  'id',
                ) as NodePath<BabelTypes.ObjectPattern>

                const properties = pattern.get('properties')
                properties.forEach((p) => {
                  const local = p.get(
                    p.node.type === 'ObjectProperty'
                      ? 'value'
                      : p.node.type === 'RestElement'
                      ? 'argument'
                      : (function () {
                          throw new Error('invariant')
                        })(),
                  ) as NodePath<BabelTypes.Identifier>
                  if (isIdentifierReferenced(local)) {
                    state.refs.add(local)
                  }
                })
              } else if (variablePath.node.id.type === 'ArrayPattern') {
                const pattern = variablePath.get(
                  'id',
                ) as NodePath<BabelTypes.ArrayPattern>

                const elements = pattern.get('elements')
                elements.forEach((e) => {
                  let local: NodePath<BabelTypes.Identifier>
                  if (e.node?.type === 'Identifier') {
                    local = e as NodePath<BabelTypes.Identifier>
                  } else if (e.node?.type === 'RestElement') {
                    local = e.get('argument') as NodePath<BabelTypes.Identifier>
                  } else {
                    return
                  }

                  if (isIdentifierReferenced(local)) {
                    state.refs.add(local)
                  }
                })
              }
            },

            FunctionDeclaration: markFunction,
            FunctionExpression: markFunction,
            ArrowFunctionExpression: markFunction,
            ImportSpecifier: markImport,
            ImportDefaultSpecifier: markImport,
            ImportNamespaceSpecifier: markImport,

            ExportNamedDeclaration(path) {
              const insertIndicator = (
                path: NodePath<BabelTypes.ExportNamedDeclaration>,
                exportName: string,
              ) => {
                path.insertBefore(
                  t.exportNamedDeclaration(
                    t.variableDeclaration('var', [
                      t.variableDeclarator(
                        t.identifier(exportName),
                        t.numericLiteral(1),
                      ),
                    ]),
                  ),
                )
              }

              let shouldRemove = false

              // Handle re-exports: export { preload } from './foo'
              path.node.specifiers = path.node.specifiers.filter((spec) => {
                if (spec.exported.type !== 'Identifier') {
                  return true
                }

                const { name } = spec.exported
                for (const namedExport of namedExports) {
                  if (name === namedExport) {
                    insertIndicator(path, namedExport)
                    state.removedNamedExports.add(namedExport)
                    return false
                  }
                }

                return true
              })

              const { declaration } = path.node

              // When none of Re-exports left, remove the path
              if (!declaration && path.node.specifiers.length === 0) {
                shouldRemove = true
              }

              if (declaration && declaration.type === 'VariableDeclaration') {
                declaration.declarations = declaration.declarations.filter(
                  (declarator: BabelTypes.VariableDeclarator) => {
                    for (const name of namedExports) {
                      if (
                        (declarator.id as BabelTypes.Identifier).name ===
                          name &&
                        declarator.init?.type.includes('Function') // ArrowFunctionExpression or FunctionExpression
                      ) {
                        insertIndicator(path, name)
                        state.removedNamedExports.add(name)
                        return false
                      }
                    }
                    return true
                  },
                )
                if (declaration.declarations.length === 0) {
                  shouldRemove = true
                }
              }

              if (declaration && declaration.type === 'FunctionDeclaration') {
                for (const name of namedExports) {
                  // @ts-ignore
                  if (declaration.id.name === name) {
                    shouldRemove = true
                    state.removedNamedExports.add(name)
                    insertIndicator(path, name)
                  }
                }
              }

              if (shouldRemove) {
                path.remove()
              }
            },
          })

          if (state.removedNamedExports.size === 0) {
            // No server-spcific exports found
            // No need to clean unused references then
            return
          }

          if (state.opts.done) {
            state.opts.done(state)
          }

          const refs = state.refs

          let count: number

          function sweepFunction(
            path: NodePath<
              | BabelTypes.FunctionDeclaration
              | BabelTypes.FunctionExpression
              | BabelTypes.ArrowFunctionExpression
            >,
          ) {
            const ident = getIdentifier(path)
            if (
              ident?.node &&
              refs.has(ident) &&
              !isIdentifierReferenced(ident)
            ) {
              ++count

              if (
                t.isAssignmentExpression(path.parentPath) ||
                t.isVariableDeclarator(path.parentPath)
              ) {
                path.parentPath.remove()
              } else {
                path.remove()
              }
            }
          }

          function sweepImport(
            path: NodePath<
              | BabelTypes.ImportSpecifier
              | BabelTypes.ImportDefaultSpecifier
              | BabelTypes.ImportNamespaceSpecifier
            >,
          ) {
            const local = path.get('local')
            if (refs.has(local) && !isIdentifierReferenced(local)) {
              ++count
              path.remove()
              if (
                (path.parent as BabelTypes.ImportDeclaration).specifiers
                  .length === 0
              ) {
                path.parentPath.remove()
              }
            }
          }

          // Traverse again to remove unused dependencies
          // We do this at least once
          // If something is removed `count` will be true so it will run again
          // Otherwise it exists the loop
          do {
            ;(path.scope as any).crawl()
            count = 0

            path.traverse({
              VariableDeclarator(variablePath) {
                if (variablePath.node.id.type === 'Identifier') {
                  const local = variablePath.get(
                    'id',
                  ) as NodePath<BabelTypes.Identifier>
                  if (refs.has(local) && !isIdentifierReferenced(local)) {
                    ++count
                    variablePath.remove()
                  }
                } else if (variablePath.node.id.type === 'ObjectPattern') {
                  const pattern = variablePath.get(
                    'id',
                  ) as NodePath<BabelTypes.ObjectPattern>

                  const beforeCount = count
                  const properties = pattern.get('properties')
                  properties.forEach((p) => {
                    const local = p.get(
                      p.node.type === 'ObjectProperty'
                        ? 'value'
                        : p.node.type === 'RestElement'
                        ? 'argument'
                        : (function () {
                            throw new Error('invariant')
                          })(),
                    ) as NodePath<BabelTypes.Identifier>

                    if (refs.has(local) && !isIdentifierReferenced(local)) {
                      ++count
                      p.remove()
                    }
                  })

                  if (
                    beforeCount !== count &&
                    pattern.get('properties').length < 1
                  ) {
                    variablePath.remove()
                  }
                } else if (variablePath.node.id.type === 'ArrayPattern') {
                  const pattern = variablePath.get(
                    'id',
                  ) as NodePath<BabelTypes.ArrayPattern>

                  const beforeCount = count
                  const elements = pattern.get('elements')
                  elements.forEach((e) => {
                    let local: NodePath<BabelTypes.Identifier>
                    if (e.node?.type === 'Identifier') {
                      local = e as NodePath<BabelTypes.Identifier>
                    } else if (e.node?.type === 'RestElement') {
                      local = e.get(
                        'argument',
                      ) as NodePath<BabelTypes.Identifier>
                    } else {
                      return
                    }

                    if (refs.has(local) && !isIdentifierReferenced(local)) {
                      ++count
                      e.remove()
                    }
                  })

                  if (
                    beforeCount !== count &&
                    pattern.get('elements').length < 1
                  ) {
                    variablePath.remove()
                  }
                }
              },
              FunctionDeclaration: sweepFunction,
              FunctionExpression: sweepFunction,
              ArrowFunctionExpression: sweepFunction,
              ImportSpecifier: sweepImport,
              ImportDefaultSpecifier: sweepImport,
              ImportNamespaceSpecifier: sweepImport,
            })
          } while (count)
        },
      },
    },
  }
}
