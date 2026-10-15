#include <sys/sysctl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <errno.h>

static int denied_environment_sysctl(int *, u_int, void *, size_t *, void *, size_t);

/* Inject one unreadable environment operation; every BSD identity remains a kernel read. */
#define sysctl denied_environment_sysctl
#include "../process-environment.c"
#undef sysctl

static int denied_environment_sysctl(int *mib, u_int length, void *old, size_t *old_length, void *newer, size_t new_length) {
  if (length == 3 && mib[0] == CTL_KERN && mib[1] == KERN_PROCARGS2) {
    const char *ledger = getenv("MAISTER_TEST_PROCESS_LEDGER");
    char filename[PATH_MAX];
    if (!ledger || snprintf(filename, sizeof(filename), "%s/process-environment-denied-pid", ledger) >= (int)sizeof(filename)) {
      errno = EINVAL;
      return -1;
    }
    FILE *control = fopen(filename, "r");
    if (!control) return -1;
    int denied_pid;
    int found = fscanf(control, "%d", &denied_pid);
    fclose(control);
    if (found != 1 || denied_pid <= 0) {
      errno = EINVAL;
      return -1;
    }
    if (mib[2] == denied_pid) {
      errno = EACCES;
      return -1;
    }
  }
  return sysctl(mib, length, old, old_length, newer, new_length);
}
