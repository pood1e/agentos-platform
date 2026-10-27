import { buildDecrypt } from "@aws-crypto/decrypt-node";
import { buildEncrypt } from "@aws-crypto/encrypt-node";
import { AlgorithmSuiteIdentifier, CommitmentPolicy } from "@aws-crypto/material-management-node";
import { RawAesKeyringNode, RawAesWrappingSuiteIdentifier } from "@aws-crypto/raw-aes-keyring-node";
import { Code, ConnectError } from "@connectrpc/connect";

const client = {
  commitmentPolicy: CommitmentPolicy.REQUIRE_ENCRYPT_REQUIRE_DECRYPT,
  maxEncryptedDataKeys: 1,
};
const { encrypt } = buildEncrypt(client);
const { decrypt } = buildDecrypt(client);

/** AWS Encryption SDK messages name their wrapping key and carry the record identity as context. */
export function envelope(key: Uint8Array) {
  if (key.length !== 32) throw new Error("Execution encryption requires a 256-bit key");
  const keyring = new RawAesKeyringNode({
    keyNamespace: "agentos",
    keyName: "execution",
    // The keyring zeroes the material it receives.
    unencryptedMasterKey: Uint8Array.from(key),
    wrappingSuite: RawAesWrappingSuiteIdentifier.AES256_GCM_IV12_TAG16_NO_PADDING,
  });
  return {
    async seal(plaintext: Uint8Array, context: Record<string, string>) {
      const { result } = await encrypt(keyring, plaintext, {
        suiteId: AlgorithmSuiteIdentifier.ALG_AES256_GCM_IV12_TAG16_HKDF_SHA512_COMMIT_KEY,
        encryptionContext: context,
      });
      return result;
    },
    async open(message: Uint8Array, context: Record<string, string>) {
      try {
        const { plaintext, messageHeader } = await decrypt(keyring, message);
        const sealed = messageHeader.encryptionContext;
        if (Object.entries(context).some(([name, value]) => sealed[name] !== value))
          throw new Error("Encryption context mismatch");
        return plaintext;
      } catch {
        throw new ConnectError("Execution state is invalid", Code.PermissionDenied);
      }
    },
  };
}
