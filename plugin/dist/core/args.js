// Command-line flags, read one way everywhere: the command that runs and the error handler that explains its failure
// must agree on which file `--db` named.
/** The word after `--<name>`, or undefined when the flag is not given. */
export const flag = (name, argv = process.argv) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
};
