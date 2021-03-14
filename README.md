# babel-plugin-eliminator

## What is this?

This is a babel plugin for removing specific named exports in your JavaScript code, this is how Next.js implements `getServerSideProps` and `getStaticProps`, it essentially removes thoses exports and referenced variables.

## Install

```bash
npm i babel-plugin-eliminator
```

## Usage

### Removing specific named exports

Options:

```json
{
  "plugins": [
    ["eliminator", {"namedExports": ["foo"]}]
  ]
}
```

Input:

```ts
import pkg from 'some-pkg'

const someVariable = 'some-string'

export const foo = () => {
    return pkg(someVariable)
}
```

Output:

```ts
export var foo = 1
```

## Options

```ts
type PluginState = {
  refs: Set<NodePath<BabelTypes.Identifier>>
  opts: PluginOpts
  /** Removed named exports */
  removedNamedExports: Set<string>
}

type PluginOpts = {
  /** Removing specific named exports */
  namedExports?: string[]
  /** Called at the end of transpiling */
  done?: (state: PluginState) => void
}
```

## Credits

This plugin is essentially a fork of [next.js/next-ssg-transform](https://github.com/vercel/next.js/blob/574fe0b582d5cc1b13663121fd47a3d82deaaa17/packages/next/build/babel/plugins/next-ssg-transform.ts).

## License

MIT &copy; [EGOIST](https://github.com/sponsors/egoist)