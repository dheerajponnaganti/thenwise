// The Store interface (spec 07 §3): every backend implements it; retrieval and writing never know which one they use.
// Records are ParsedNote with a guaranteed id. Every method is async so database backends fit the same shape.
export class StoreError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
