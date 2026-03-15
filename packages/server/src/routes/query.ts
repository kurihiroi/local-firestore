import type { ErrorResponse, QueryRequest, QueryResponse } from "@local-firestore/shared";
import { Hono } from "hono";
import type { QueryService } from "../services/query.js";
import { isCollectionPath } from "../utils/path.js";

export function createQueryRoutes(queryService: QueryService): Hono {
  const app = new Hono();

  // POST /query - クエリ実行
  app.post("/query", async (c) => {
    const body = await c.req.json<QueryRequest>();

    if (!body.collectionGroup && !isCollectionPath(body.collectionPath)) {
      return c.json<ErrorResponse>(
        { code: "invalid-argument", message: "Invalid collection path" },
        400,
      );
    }

    const results = queryService.executeQuery(
      body.collectionPath,
      body.constraints,
      body.collectionGroup,
    );

    const response: QueryResponse = {
      docs: results.map((doc) => ({
        path: doc.path,
        data: doc.data,
        createTime: doc.createTime,
        updateTime: doc.updateTime,
      })),
    };

    return c.json(response);
  });

  return app;
}
