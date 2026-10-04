/**
 * Host half of @dev_zf/dsh-conversation-search.
 *
 * The plugin is entirely a browser (Client) plugin: package.json declares
 * `dsh.client` and `@deepseek-ai/dsh-client-modules` composes the built
 * `./client` artifact into the Web boot graph. The Host therefore only needs a
 * loadable row so the bundle layer resolves; it registers nothing.
 */
export const name = 'conversation-search'

export function apply() {}
