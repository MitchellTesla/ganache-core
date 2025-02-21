import assert from "assert";
import getProvider from "../../helpers/getProvider";
import compile from "../../helpers/compile";
import { join } from "path";
import EthereumProvider from "../../../src/provider";
import { EthereumProviderOptions } from "@ganache/ethereum-options";

describe("api", () => {
  describe("eth", () => {
    describe("sendTransaction", () => {
      describe("options", () => {
        describe("defaultTransactionGasLimit", () => {
          it('uses an estimate when `defaultTransactionGasLimit` is set to `"estimate"`', async () => {
            const provider = await getProvider({
              miner: {
                defaultTransactionGasLimit: "estimate"
              }
            });
            const [from] = await provider.send("eth_accounts");

            const gasPrice = await provider.send("eth_gasPrice", []);
            const gasEstimate = await provider.send("eth_estimateGas", [
              {
                from,
                to: from,
                gasPrice
              }
            ]);
            await provider.send("eth_subscribe", ["newHeads"]);

            const hash = await provider.send("eth_sendTransaction", [
              {
                from,
                to: from,
                gasPrice
              }
            ]);

            await provider.once("message");

            const { gas } = await provider.send("eth_getTransactionByHash", [
              hash
            ]);
            assert.strictEqual(gas, gasEstimate);
          });
        });
      });

      describe("insufficient funds", () => {
        it("returns an error when account has insufficient funds to send the transaction", async () => {
          const p = await getProvider({
            miner: { legacyInstamine: true },
            chain: { vmErrorsOnRPCResponse: true }
          });
          const [from, to] = await p.send("eth_accounts");
          const balance = await p.send("eth_getBalance", [from]);
          const types = ["0x0", "0x1", "0x2"] as const;
          for (let i = 0; i < types.length; i++) {
            await assert.rejects(
              p.send("eth_sendTransaction", [
                { type: types[i], from, to, value: balance }
              ]),
              new RegExp(
                `VM Exception while processing transaction: sender doesn't have enough funds to send tx\\. The upfront cost is: \\d+ and the sender's account \\(${from}\\) only has: ${BigInt(
                  balance
                )} \\(vm hf=london -> block -> tx\\)`
              )
            );
          }
        });
      });

      describe("contracts", () => {
        const contractDir = join(__dirname, "contracts");
        describe("out of gas", () => {
          let provider: EthereumProvider;
          let from: string;
          beforeEach(async () => {
            provider = await getProvider();
            [from] = await provider.send("eth_accounts");
          });

          it('returns `"0x0"` `status`, `null` `to`, and a non-empty `contractAddress` on OOG failure', async () => {
            const { code: data } = compile(join(contractDir, "NoOp.sol"));

            await provider.send("eth_subscribe", ["newHeads"]);

            const transactionHash = await provider.send("eth_sendTransaction", [
              {
                from,
                data,
                gas: `0x${(54400).toString(16)}` // 54400 is not quite enough gas for this tx
              }
            ]);

            await provider.once("message");

            const receipt = await provider.send("eth_getTransactionReceipt", [
              transactionHash
            ]);
            assert.strictEqual(receipt.status, "0x0");
            // ensure that even though the status is `"0x0"` (failure), the
            // `contractAddress` is included and the `to` prop is still `null`.
            assert.strictEqual(receipt.to, null);
            assert.notStrictEqual(receipt.contractAddress, null);
            assert.strictEqual(receipt.contractAddress.length, 42);
          });
        });

        describe("revert", () => {
          async function deployContract(
            provider: EthereumProvider,
            accounts: string[]
          ) {
            const contract = compile(join(contractDir, "Reverts.sol"));

            const from = accounts[0];

            await provider.send("eth_subscribe", ["newHeads"]);

            const transactionHash = await provider.send("eth_sendTransaction", [
              {
                from,
                data: contract.code,
                gas: "0x2fefd8"
              }
            ]);

            await provider.once("message");

            const receipt = await provider.send("eth_getTransactionReceipt", [
              transactionHash
            ]);
            assert.strictEqual(receipt.blockNumber, "0x1");

            const contractAddress = receipt.contractAddress;
            return {
              contract,
              contractAddress
            };
          }

          it("doesn't crash on badly encoded revert string", async () => {
            async function test(opts: EthereumProviderOptions) {
              const provider = await getProvider(opts);
              const accounts = await provider.send("eth_accounts");
              const { contract, contractAddress } = await deployContract(
                provider,
                accounts
              );
              const contractMethods = contract.contract.evm.methodIdentifiers;
              const prom = provider.send("eth_call", [
                {
                  from: accounts[0],
                  to: contractAddress,
                  data: "0x" + contractMethods["invalidRevertReason()"]
                }
              ]);

              const revertString =
                "0x08c379a0ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc0";
              const result = await prom.catch(e => e);
              assert.strictEqual(
                result.code,
                -32000,
                "Error code should be -32000"
              );
              assert.strictEqual(
                result.data.reason,
                null,
                "The reason is undecodable, and thus should be null"
              );
              assert.strictEqual(
                result.data.message,
                "revert",
                "The message should not have a reason string included"
              );
              assert.strictEqual(
                result.data.result,
                revertString,
                "The revert reason should be encoded as hex"
              );
            }
            await test({});
          });
        });
      });

      describe("unlocked accounts", () => {
        it("can send transactions from an unlocked 0x0 address", async () => {
          const ZERO_ADDRESS = "0x" + "0".repeat(40);
          const provider = await getProvider({
            miner: {
              defaultGasPrice: 0
            },
            wallet: {
              unlockedAccounts: [ZERO_ADDRESS]
            },
            chain: {
              // use berlin here because we just want to test if we can use the
              // "zero" address, and we do this by transferring value while
              // setting the gasPrice to `0`. This isn't possible after the
              // `london` hardfork currently, as we don't provide an option to
              // allow for a 0 `maxFeePerGas` value.
              // TODO: remove once we have a configurable `maxFeePerGas`
              hardfork: "berlin"
            }
          });
          const [from] = await provider.send("eth_accounts");
          await provider.send("eth_subscribe", ["newHeads"]);
          const initialZeroBalance = "0x1234";
          await provider.send("eth_sendTransaction", [
            { from: from, to: ZERO_ADDRESS, value: initialZeroBalance }
          ]);
          await provider.once("message");
          const initialBalance = await provider.send("eth_getBalance", [
            ZERO_ADDRESS
          ]);
          assert.strictEqual(
            initialBalance,
            initialZeroBalance,
            "Zero address's balance isn't correct"
          );
          const removeValueFromZeroAmount = "0x123";
          await provider.send("eth_sendTransaction", [
            { from: ZERO_ADDRESS, to: from, value: removeValueFromZeroAmount }
          ]);
          await provider.once("message");
          const afterSendBalance = BigInt(
            await provider.send("eth_getBalance", [ZERO_ADDRESS])
          );
          assert.strictEqual(
            BigInt(initialZeroBalance) - BigInt(removeValueFromZeroAmount),
            afterSendBalance,
            "Zero address's balance isn't correct"
          );
        });

        it("unlocks accounts via unlock_accounts (both string and numbered numbers)", async () => {
          const p = await getProvider({
            wallet: {
              lock: true,
              unlockedAccounts: ["0", 1]
            }
          });

          const accounts = await p.send("eth_accounts");
          const balance1_1 = await p.send("eth_getBalance", [accounts[1]]);
          const badSend = async () => {
            return p.send("eth_sendTransaction", [
              {
                from: accounts[2],
                to: accounts[1],
                value: "0x7b"
              }
            ]);
          };
          await assert.rejects(
            badSend,
            "Error: authentication needed: passphrase or unlock"
          );

          await p.send("eth_subscribe", ["newHeads"]);
          await p.send("eth_sendTransaction", [
            {
              from: accounts[0],
              to: accounts[1],
              value: "0x7b"
            }
          ]);

          await p.once("message");

          const balance1_2 = await p.send("eth_getBalance", [accounts[1]]);
          assert.strictEqual(BigInt(balance1_1) + 123n, BigInt(balance1_2));

          const balance0_1 = await p.send("eth_getBalance", [accounts[0]]);

          await p.send("eth_sendTransaction", [
            {
              from: accounts[1],
              to: accounts[0],
              value: "0x7b"
            }
          ]);

          await p.once("message");

          const balance0_2 = await p.send("eth_getBalance", [accounts[0]]);
          assert.strictEqual(BigInt(balance0_1) + 123n, BigInt(balance0_2));
        });
      });
    });
  });
});
