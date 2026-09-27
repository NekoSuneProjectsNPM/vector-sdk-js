/**
 * `vector-bot` — the command-line front door.
 *
 * Creating a Vector bot means creating a Nostr keypair, and that is a thing you
 * do on your own machine rather than by signing up anywhere. This wraps it so
 * nobody has to write code to get a bot account, publish its profile, or add a
 * friend.
 */
export declare function main(argv?: string[]): Promise<number>;
