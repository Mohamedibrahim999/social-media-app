import mongoose from "mongoose";

/**
 * Probes whether the MongoDB-compatible server honours single-document atomic compare-and-set
 * (real MongoDB does; some stand-ins such as FerretDB's SQLite backend do not).
 * Concurrency tests are SKIPPED (visibly) when it does not, instead of silently passing or flaking.
 */
export default async function globalSetup(): Promise<void> {
  const uri = process.env.MONGO_TEST_URI ?? "mongodb://127.0.0.1:27017/tapi_test";
  const connection = await mongoose.createConnection(uri).asPromise();
  try {
    const collection = connection.db!.collection("atomicity_probe");
    let atomic = true;
    for (let round = 0; round < 4 && atomic; round++) {
      await collection.deleteMany({});
      await collection.insertOne({ _id: "t" as never, status: "active" });
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          collection.findOneAndUpdate({ _id: "t" as never, status: "active" }, { $set: { status: "done", by: i } }, { returnDocument: "after" })
        )
      );
      atomic = results.filter((result) => result !== null).length === 1;
    }
    await collection.drop().catch(() => undefined);
    process.env.TAPI_ATOMIC_CAS = atomic ? "1" : "0";
    if (!atomic) console.warn("\n[tests] This MongoDB-compatible server is NOT atomic for concurrent CAS: concurrency tests will be skipped.\n");
  } finally {
    await connection.close();
  }
}
