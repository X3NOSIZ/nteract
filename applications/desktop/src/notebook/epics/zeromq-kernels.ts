import { ChildProcess } from "child_process";

import { Observable, of, merge, empty } from "rxjs";
import { sample } from "lodash";
import {
  filter,
  map,
  tap,
  mergeMap,
  catchError,
  switchMap,
  concatMap,
  timeout,
  first
} from "rxjs/operators";
import { launchSpec } from "spawnteract";
import { ActionsObservable, ofType, StateObservable } from "redux-observable";
import { ipcRenderer as ipc } from "electron";
import { createMainChannel } from "enchannel-zmq-backend";
import * as jmp from "jmp";
import {
  selectors,
  actions,
  AppState,
  KernelspecInfo,
  KernelRef,
  ContentRef,
  LocalKernelProps
} from "@nteract/core";
import {
  childOf,
  ofMessageType,
  shutdownRequest,
  Channels
} from "@nteract/messaging";

import { Actions } from "../actions";

/**
 * Instantiate a connection to a new kernel.
 *
 * @param  {KernelInfo}  kernelSpec The kernel specs - name,language, etc
 * @param  {String}  cwd The working directory to launch the kernel in
 */
export function launchKernelObservable(
  kernelSpec: KernelspecInfo,
  cwd: string,
  kernelRef: KernelRef,
  contentRef: ContentRef
): Observable<Actions> {
  const spec = kernelSpec.spec;

  return Observable.create(observer => {
    launchSpec(spec, { cwd, stdio: ["ignore", "pipe", "pipe"] }).then(c => {
      const { config, spawn, connectionFile } = c;

      // Pick a random color for the kernel to assist in debugging kernels
      const logColor = sample([
        "#404040",
        "#704040",
        "#407040",
        "#404070",
        "#704070",
        "#707040",
        "#407070",
        "#707070"
      ]);

      const logStd = text => {
        console.log(
          `%c${text}`,
          `color: ${logColor}; font-family: Source Code Pro, courier;`
        );
      };

      console.log(
        `\n>>>> %cLogging kernel ${
          kernelSpec.name
        } (ref ${kernelRef}) stdout and stderr to javascript console in %cthis color %c  %c <<<<\n`,
        `font-weight: bold;`,
        `color: ${logColor}; font-weight: bold;`,
        `background-color: ${logColor}; padding: 2px;`,
        `color: black`
      );

      spawn.stdout.on("data", data => {
        const text = data.toString();
        logStd(text);
        observer.next(actions.kernelRawStdout({ text, kernelRef }));
      });
      spawn.stderr.on("data", data => {
        const text = data.toString();
        logStd(text);
        observer.next(actions.kernelRawStderr({ text, kernelRef }));
      });

      // do dependency injection of jmp to make it match our ABI version of node
      createMainChannel(config, undefined, undefined, undefined, jmp)
        .then((channels: Channels) => {
          observer.next(
            actions.setKernelspecInfo({
              kernelInfo: kernelSpec,
              contentRef: contentRef
            })
          );

          const kernel: LocalKernelProps = {
            info: null,
            type: "zeromq",
            hostRef: null,
            channels,
            connectionFile,
            spawn,
            cwd,
            kernelSpecName: kernelSpec.name,
            lastActivity: null,
            status: "launched" // TODO: Determine our taxonomy
          };

          observer.next(
            actions.launchKernelSuccessful({
              kernel,
              kernelRef,
              contentRef,
              selectNextKernel: true
            })
          );
          // TODO: Request status right after
          observer.next(
            actions.setExecutionState({ kernelStatus: "launched", kernelRef })
          );
          observer.complete();
        })
        .catch(error => {
          observer.error({ type: "ERROR", payload: error, err: true });
        });
    });
  });
}

interface Kernelspecs {
  [name: string]: KernelspecInfo;
}

/**
 * Get kernel specs from main process
 *
 * @returns  {Observable}  The reply from main process
 */
export const kernelSpecsObservable: Observable<Kernelspecs> = new Observable<
  Kernelspecs
>(observer => {
  ipc.on("kernel_specs_reply", (event, specs: Kernelspecs) => {
    observer.next(specs);
    observer.complete();
  });
  ipc.send("kernel_specs_request");
});

export const launchKernelByNameEpic = (
  action$: ActionsObservable<Actions>
): Observable<Actions> =>
  action$.pipe(
    ofType(actions.LAUNCH_KERNEL_BY_NAME),
    tap((action: actions.LaunchKernelByNameAction) => {
      if (!action.payload.kernelSpecName) {
        throw new Error("launchKernelByNameEpic requires a kernel name");
      }
    }),
    mergeMap((action: actions.LaunchKernelByNameAction) =>
      kernelSpecsObservable.pipe(
        map(specs => {
          const kernelSpec = specs[action.payload.kernelSpecName];
          if (kernelSpec) {
            // Defer to a launchKernel action to _actually_ launch
            return actions.launchKernel({
              contentRef: action.payload.contentRef,
              cwd: action.payload.cwd,
              kernelRef: action.payload.kernelRef,
              kernelSpec,
              selectNextKernel: action.payload.selectNextKernel
            });
          } else {
            return actions.launchKernelFailed({
              contentRef: action.payload.contentRef,
              error: new Error(
                `Kernel named ${
                  action.payload.kernelSpecName
                } does not appear to be available.`
              ),
              kernelRef: action.payload.kernelRef
            });
          }
        })
      )
    )
  );

type LaunchKernelResponseActions =
  | actions.KillKernelAction
  | actions.ErrorAction<"ERROR">;

/**
 * Launches a new kernel.
 *
 * @param  {ActionObservable} action$  ActionObservable for LAUNCH_KERNEL action
 */
export const launchKernelEpic = (
  action$: ActionsObservable<Actions>,
  state$: StateObservable<AppState>
): Observable<Actions> => {
  const response$ = action$.pipe(
    ofType(actions.LAUNCH_KERNEL),
    // We must kill the previous kernel now
    // Then launch the next one
    switchMap((action: actions.LaunchKernelAction) => {
      if (
        !action.payload ||
        !action.payload.kernelSpec ||
        !action.payload.kernelRef
      ) {
        return of(
          actions.launchKernelFailed({
            error: new Error("launchKernel needs a kernelSpec and a kernelRef"),
            kernelRef: action.payload && action.payload.kernelRef,
            contentRef: action.payload.contentRef
          })
        );
      }

      // TODO: Do the async version of `ipc.send`, potentially coordinate with main process
      ipc.send("nteract:ping:kernel", action.payload.kernelSpec);

      const oldKernelRef = selectors.currentKernelRef(state$.value);

      // Kill the old kernel by emitting the action to kill it if it exists
      let cleanupOldKernel$:
        | Observable<never>
        | Observable<actions.KillKernelAction> = empty();
      if (oldKernelRef && oldKernelRef !== action.payload.kernelRef) {
        cleanupOldKernel$ = of(
          actions.killKernel({ restarting: false, kernelRef: oldKernelRef })
        );
      }

      return merge(
        launchKernelObservable(
          action.payload.kernelSpec,
          action.payload.cwd,
          action.payload.kernelRef,
          action.payload.contentRef
        ),
        // Was there a kernel before (?) -- kill it if so, otherwise nothing else
        cleanupOldKernel$
      ).pipe(
        catchError((error: Error) =>
          of(
            actions.launchKernelFailed({
              error,
              kernelRef: action.payload.kernelRef,
              contentRef: action.payload.contentRef
            })
          )
        )
      );
    }),
    catchError((error: Error) => {
      return of({ type: "ERROR", payload: error, error: true });
    })
  );

  return response$;
};

type InterruptActions =
  | actions.InterruptKernel
  | actions.InterruptKernelFailed
  | actions.InterruptKernelSuccessful;

export const interruptKernelEpic = (
  action$: ActionsObservable<InterruptActions>,
  state$: StateObservable<AppState>
): Observable<InterruptActions> =>
  action$.pipe(
    ofType(actions.INTERRUPT_KERNEL),
    // This epic can only interrupt direct zeromq connected kernels
    filter(() => selectors.isCurrentKernelZeroMQ(state$.value)),
    // If the user fires off _more_ interrupts, we shouldn't interrupt the in-flight
    // interrupt, instead doing it after the last one happens
    concatMap(
      (action: actions.InterruptKernel): Observable<InterruptActions> => {
        const kernel = selectors.currentKernel(state$.value);
        if (!kernel) {
          return of(
            actions.interruptKernelFailed({
              error: new Error("Can't interrupt a kernel we don't have"),
              kernelRef: action.payload.kernelRef
            })
          );
        }

        if (kernel.type !== "zeromq" || !kernel.spawn) {
          return of(
            actions.interruptKernelFailed({
              error: new Error("Invalid kernel type for interrupting"),
              kernelRef: action.payload.kernelRef
            })
          );
        }

        const spawn = kernel.spawn;

        //
        // From the node.js docs
        //
        // > The ChildProcess object may emit an 'error' event if the signal cannot be delivered.
        //
        // This is instead handled in the watchSpawnEpic below
        spawn.kill("SIGINT");

        return of(
          actions.interruptKernelSuccessful({
            kernelRef: action.payload.kernelRef
          })
        );
      }
    )
  );

function killSpawn(spawn: ChildProcess): void {
  // Clean up all the terminal streams
  // "pause" stdin, which puts it back in its normal state
  if (spawn.stdin && spawn.stdin.destroy) {
    spawn.stdin.destroy();
  }
  spawn.stdout.destroy();
  spawn.stderr.destroy();

  // Kill the process fully
  spawn.kill("SIGKILL");
}

// This might be better named shutdownKernel because it first attempts a graceful
// shutdown by sending a shutdown msg to the kernel, and only if the kernel
// doesn't respond promptly does it SIGKILL the kernel.
export const killKernelEpic = (
  action$: ActionsObservable<Actions>,
  state$: StateObservable<AppState>
): Observable<Actions> =>
  action$.pipe(
    ofType(actions.KILL_KERNEL),
    concatMap((action: actions.KillKernelAction) => {
      const kernelRef = action.payload.kernelRef;
      const kernel = selectors.kernel(state$.value, { kernelRef });

      if (!kernel) {
        console.warn("tried to kill a kernel that doesn't exist");
        return empty();
      }

      // Ignore the action if the specified kernel is not ZMQ.
      if (kernel.type !== "zeromq") {
        return empty();
      }

      const request = shutdownRequest({ restart: false });

      // Try to make a shutdown request
      // If we don't get a response within X time, force a shutdown
      // Either way do the same cleanup
      const shutDownHandling = kernel.channels.pipe(
        childOf(request),
        ofMessageType("shutdown_reply"),
        first(),
        // If we got a reply, great! :)
        map(msg =>
          actions.shutdownReplySucceeded({ text: msg.content, kernelRef })
        ),
        // If we don't get a response within 2s, assume failure :(
        timeout(1000 * 2),
        catchError(err =>
          of(actions.shutdownReplyTimedOut({ error: err, kernelRef }))
        ),
        mergeMap(action => {
          // End all communication on the channels
          kernel.channels.complete();

          if (kernel.spawn) {
            killSpawn(kernel.spawn);
          }

          return merge(
            // Pass on our intermediate action (whether or not kernel ACK'd shutdown request promptly)
            of(action),
            // Indicate overall success (channels cleaned up)
            of(
              actions.killKernelSuccessful({
                kernelRef: kernelRef
              })
            ),
            // Inform about the state
            of(
              actions.setExecutionState({
                kernelStatus: "shutting down",
                kernelRef
              })
            )
          );
        }),
        catchError(err =>
          // Catch all, in case there were other errors here
          of(actions.killKernelFailed({ error: err, kernelRef }))
        )
      );

      // On subscription, send the message
      return Observable.create(observer => {
        const subscription = shutDownHandling.subscribe(observer);
        kernel.channels.next(request);
        return subscription;
      });
    })
  );

export function watchSpawn(action$: ActionsObservable<Actions>) {
  return action$.pipe(
    ofType(actions.LAUNCH_KERNEL_SUCCESSFUL),
    switchMap((action: actions.NewKernelAction) => {
      if (action.payload.kernel.type !== "zeromq") {
        throw new Error("kernel.type is not zeromq.");
      }
      if (!action.payload.kernel.spawn) {
        throw new Error("kernel.spawn is not provided.");
      }
      const spawn: ChildProcess = action.payload.kernel.spawn;
      return Observable.create(observer => {
        spawn.on("error", error => {
          // We both set the state and make it easy for us to log the error
          observer.next(
            actions.setExecutionState({
              kernelStatus: "process errored",
              kernelRef: action.payload.kernelRef
            })
          );
          observer.error({ type: "ERROR", payload: error, err: true });
          observer.complete();
        });
        spawn.on("exit", () => {
          observer.next(
            actions.setExecutionState({
              kernelStatus: "process exited",
              kernelRef: action.payload.kernelRef
            })
          );
          observer.complete();
        });
        spawn.on("disconnect", () => {
          observer.next(
            actions.setExecutionState({
              kernelStatus: "process disconnected",
              kernelRef: action.payload.kernelRef
            })
          );
          observer.complete();
        });
      });
    })
  );
}
