/* eslint-disable @typescript-eslint/no-explicit-any */
import mongoose from "mongoose";
import { randomUUID } from "crypto";
import { env } from "../config/env";

const MIGRATION_ID = "001-page-id-to-uuid";

const run = async (): Promise<void> => {
  await mongoose.connect(env.MONGO_URI);

  const db = mongoose.connection.db;

  if (!db) {
    throw new Error("MongoDB database connection is not available");
  }

  const migrationsCollection = db.collection("migrations");

  const alreadyApplied =
    await migrationsCollection.findOne({
      migrationId: MIGRATION_ID,
    });

  if (alreadyApplied) {
    console.log(
      `Migration ${MIGRATION_ID} already applied`
    );
    return;
  }

  const pagesCollection = db.collection<any>("pages");
  const pageMembersCollection = db.collection<any>("pagemembers");
  const subscriptionsCollection =
    db.collection<any>("subscriptions");
  const postsCollection = db.collection<any>("posts");

  const pages = await pagesCollection
    .find({})
    .toArray();

  console.log(
    `Found ${pages.length} page(s) to migrate`
  );

  let migratedPages = 0;

  for (const page of pages) {
    if (typeof page._id === "string") {
      console.log(
        `Skipping page ${page._id} - already uses UUID`
      );
      continue;
    }

    const oldPageId = page._id;
    const newPageId = randomUUID();

    const newPage = {
      ...page,
      _id: newPageId,
    };

    await pagesCollection.insertOne(newPage);

    await pageMembersCollection.updateMany(
      {
        pageId: oldPageId.toString(),
      },
      {
        $set: {
          pageId: newPageId,
        },
      }
    );

    await subscriptionsCollection.updateMany(
      {
        pageId: oldPageId.toString(),
      },
      {
        $set: {
          pageId: newPageId,
        },
      }
    );

    await postsCollection.updateMany(
      {
        pageId: oldPageId.toString(),
      },
      {
        $set: {
          pageId: newPageId,
        },
      }
    );

    await pagesCollection.deleteOne({
      _id: oldPageId,
    });

    migratedPages++;

    console.log(
      `Migrated page ${oldPageId} -> ${newPageId}`
    );
  }

  await migrationsCollection.insertOne({
    migrationId: MIGRATION_ID,
    appliedAt: new Date(),
    migratedPages,
  });

  console.log(
    `Migration ${MIGRATION_ID} completed`
  );
  console.log(
    `Migrated pages: ${migratedPages}`
  );
};

run()
  .catch((error) => {
    console.error(
      `Migration ${MIGRATION_ID} failed:`
    );
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });

