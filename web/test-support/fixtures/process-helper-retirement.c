#include <errno.h>
#include <limits.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

/* Schedule a real helper's retirement after the full, unchanged kernel snapshot. */
#define main native_reader_main
#include "../process-environment.c"
#undef main

int main(int argc, char **argv) {
  int result = native_reader_main(argc, argv);
  if (argc != 2 || result != 0) return result;
  const char *ledger = getenv("MAISTER_TEST_PROCESS_LEDGER");
  char filename[PATH_MAX];
  if (!ledger || snprintf(filename, sizeof(filename), "%s/process-helper-release-owner", ledger) >= (int)sizeof(filename)) return 64;
  FILE *control = fopen(filename, "r");
  if (!control) return errno == ENOENT ? result : 70;
  int helper;
  unsigned int parent, group, uid;
  unsigned long long started_seconds, started_microseconds;
  int found = fscanf(control, "%d %u %u %u %llu:%llu", &helper, &parent, &group, &uid, &started_seconds, &started_microseconds);
  fclose(control);
  if (found != 6 || helper <= 1 || parent <= 1 || group <= 1 || unlink(filename) != 0) return 64;
  struct proc_bsdinfo current;
  int observed = proc_pidinfo(helper, PROC_PIDTBSDINFO, 0, &current, sizeof(current));
  if (observed != sizeof(current) || current.pbi_pid != (unsigned int)helper ||
      current.pbi_ppid != parent || current.pbi_pgid != group || current.pbi_uid != uid ||
      current.pbi_start_tvsec != started_seconds || current.pbi_start_tvusec != started_microseconds) return 70;
  /* This scheduling signal requires the exact kernel lifetime captured from the parent's actual child. */
  if (kill(helper, SIGCONT) != 0) return 70;
  for (unsigned int attempt = 0; attempt < 1000; attempt++) {
    if (kill(helper, 0) != 0 && errno == ESRCH) {
      fprintf(stderr, "{\"event\":\"native-helper-retired-after-snapshot\",\"pid\":%d}\n", helper);
      return result;
    }
    if (usleep(1000) != 0) return 70;
  }
  return 70;
}
