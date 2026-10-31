#include <limits.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>

/* Only the command transport is controlled; successful reads use the real kernel inspector. */
#define main native_reader_main
#include "../process-environment.c"
#undef main

int main(int argc, char **argv) {
  const char *ledger = getenv("MAISTER_TEST_PROCESS_LEDGER");
  char filename[PATH_MAX];
  if (!ledger || snprintf(filename, sizeof(filename), "%s/process-transport-control", ledger) >= (int)sizeof(filename)) return 64;
  FILE *control = fopen(filename, "r+");
  if (!control) return 70;
  int mode, failures, calls;
  if (fscanf(control, "%d %d %d", &mode, &failures, &calls) != 3 ||
      mode < 1 || mode > 4 || failures < -1 || failures > 1 || calls < 0) {
    fclose(control);
    return 64;
  }
  calls++;
  rewind(control);
  if (fprintf(control, "%d %d %d\n", mode, failures, calls) < 0 || fclose(control) != 0) return 70;
  fprintf(stderr, "{\"event\":\"process-transport-control\",\"mode\":%d,\"call\":%d}\n", mode, calls);
  if (failures < 0 || calls <= failures) {
    if (mode == 1) {
      if (signal(SIGPIPE, SIG_DFL) == SIG_ERR || raise(SIGPIPE) != 0) return 70;
      return 70;
    }
    if (mode == 2) return 70;
    if (mode == 3) {
      printf("malformed native identity\n");
      return 0;
    }
    if (mode == 4) {
      if (signal(SIGTERM, SIG_DFL) == SIG_ERR || raise(SIGTERM) != 0) return 70;
      return 70;
    }
  }
  return native_reader_main(argc, argv);
}
