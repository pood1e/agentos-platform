import { create } from "@bufbuild/protobuf";
import { WorkspaceAuthorizationReferenceSchema } from "../gen/kagent/api/v1/authorization_pb.js";

export const allowWorkspace = (namespace: string) => async () =>
  create(WorkspaceAuthorizationReferenceSchema, { namespace, uid: `${namespace}-uid` });
