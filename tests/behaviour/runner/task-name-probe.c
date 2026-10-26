// Native fake client: inspect only the supplied synthetic PID, itself and a child it creates.
// Print return codes and word counts, never resource values, memory or environment contents.
#include <mach/mach.h>
#include <libproc.h>
#include <signal.h>
#include <stdio.h>
#include <sys/wait.h>
#include <unistd.h>

static void inspect(pid_t pid) {
  mach_port_t name = MACH_PORT_NULL;
  kern_return_t acquired = task_name_for_pid(mach_task_self(), pid, &name);
  const task_flavor_t flavors[] = { MACH_TASK_BASIC_INFO, TASK_EVENTS_INFO, TASK_THREAD_TIMES_INFO, TASK_VM_INFO };
  printf("{\"portResult\":%d,\"words\":[", acquired);
  for (unsigned i = 0; i < sizeof(flavors) / sizeof(flavors[0]); i++) {
    integer_t data[1024] = { 0 };
    mach_msg_type_number_t count = sizeof(data) / sizeof(data[0]);
    kern_return_t result = task_info(name, flavors[i], data, &count);
    printf("%s%u", i ? "," : "", result == KERN_SUCCESS ? count : 0);
  }
  struct proc_bsdinfo info;
  int bytes = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info));
  printf("],\"procBytes\":%d}", bytes);
  if (name != MACH_PORT_NULL) mach_port_deallocate(mach_task_self(), name);
}

int main(void) {
  int external;
  if (scanf("%d", &external) != 1 || external <= 0) return 2;
  pid_t parent = getpid();
  pid_t child = fork();
  if (child == -1) return 3;
  // A failed/terminated probe must not leave its child behind.
  if (child == 0) {
    for (unsigned i = 0; i < 10 && getppid() == parent; i++) sleep(1);
    _exit(0);
  }
  printf("{\"external\":"); inspect(external);
  printf(",\"self\":"); inspect(getpid());
  printf(",\"child\":"); inspect(child);
  pid_t children[32] = { 0 };
  proc_listchildpids(getpid(), children, sizeof(children));
  int listed = 0;
  for (unsigned i = 0; i < 32; i++) if (children[i] == child) listed = 1;
  printf(",\"childListed\":%d", listed);
  int status = 0;
  if (kill(child, SIGTERM) != 0 || waitpid(child, &status, 0) != child) return 4;
  printf(",\"childSignal\":%d}\n", WIFSIGNALED(status) ? WTERMSIG(status) : 0);
  return 0;
}
