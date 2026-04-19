
## **Building a High-Performance Combat Simulator for *The Finals*: Overcoming Challenges and Pushing the Limits of Web Development**

When I first set out to build a combat simulator for *The Finals*, I knew it would be a technically ambitious project. *The Finals* is an online multiplayer first-person shooter game, and the goal of my simulator was to compare various weapons and their effectiveness across different combat scenarios—while accounting for variables like distance and opponent skill. The end result would be an interactive heatmap, breaking down key metrics like win rates, time-to-kill (TTK), and more, all derived from running tens of thousands of simulations.

But as with any large project, things didn’t go exactly as planned. Every step came with its own challenges, and it wasn’t until I faced these roadblocks head-on that I truly understood how far my skills had grown.

### **The Beginning: A Vision of Real-Time Simulations**

The problem I set out to solve was simple yet monumental. *The Finals* has a variety of weapons, each with its own characteristics—damage profiles, fire rate, accuracy, and so on. Simulating these different weapons in various combat scenarios required running thousands of simulations in a very short time frame. The goal was to process this massive volume of data efficiently and render the results without making the browser unresponsive.

I initially envisioned the project as a basic simulation engine where users could input weapon parameters, simulate a battle, and view the results on a static table. This would provide players with a rough idea of which weapon might work best in certain scenarios. But as I started to get deeper into the project, I realized the complexity of what I was building. The raw simulation would need to account for different distances, opponent skill levels, and even the randomness of human behavior in combat. Not only that, but I also wanted to visualize this data dynamically—a task that would involve rendering an interactive heatmap, which would display results in real-time.

But as anyone who's worked with data-intensive applications knows, it's not as easy as it sounds. When I tried running a few test simulations on the main thread, the browser froze immediately. I had hit my first roadblock: **performance**.

### **The First Roadblock: Freezing the Browser**

It didn’t take long for me to realize that running thousands of simulations on the main thread simply wasn’t going to work. The browser would freeze, and the UI would become unresponsive. Even with solutions like `setTimeout` or `requestIdleCallback`, the performance was unacceptable. I remember thinking at the time, “This just isn’t feasible.”

It was a frustrating moment. I knew the tool could be useful, but it was clear that the first approach wasn’t scalable. I needed a solution that would let me run simulations in parallel—without freezing the UI.

At this point, I drew inspiration from my **parallel programming class**. I had learned that for compute-heavy tasks, especially when working with large datasets, splitting the work across multiple CPU cores is essential. Why not apply this concept to JavaScript and utilize the browser's capabilities to handle concurrency?

### **The Breakthrough: Work Stealing with Web Workers**

I decided to experiment with **Web Workers**, a feature in JavaScript that allows for running scripts in background threads. The idea was simple: I would distribute the simulation tasks across multiple workers, each running on its own thread, while the main thread would coordinate everything and handle rendering.

But the real challenge wasn’t just using Web Workers—it was **coordinating them efficiently**. I wanted a system where workers could ask for more jobs as soon as they finished a task, rather than sitting idle. The solution I implemented was **work stealing**, a pattern I had learned in class, where idle workers “steal” tasks from a global queue.

I remember the first time I got this system up and running. I was able to run **50,000 simulations** per worker—while the main thread handled the UI updates, ensuring the page remained responsive. The feeling of seeing the browser perform so smoothly, even with millions of simulations running in the background, was a breakthrough. I had finally solved the performance problem.

### **The Pain Points: Optimizing Performance and Fine-Tuning**

Despite the breakthrough, the process wasn’t all smooth sailing. One of the biggest challenges was tuning the system for performance. I had to adjust things like the **STEAL_CHUNK size**—how many jobs a worker grabs at once—while balancing the overhead of message passing between threads.

There were also some issues with **load balancing**. Some simulations took longer to run than others, leading to a scenario where certain workers would finish earlier than others, resulting in inefficient use of the available processing power. It took a lot of testing and iteration to fine-tune the balance and ensure all workers were kept busy until the end.

One of the more tricky parts was ensuring that communication between the main thread and workers remained efficient. After each batch of simulations, the workers had to send their results back to the main thread. If I didn’t aggregate the results properly, I could end up with thousands of messages, overwhelming the browser and slowing down the process.

Eventually, I found a solution: rather than sending a message for each individual simulation, each worker would send a single message with the **aggregated results** for 50,000 simulations. This drastically reduced the overhead and made the whole process much faster.

### **The Victory: Real-Time Heatmap Visualization**

With the backend simulation engine running smoothly, I turned my focus to the visualization of the results. The **heatmap** was a crucial element of the tool—it allowed users to quickly see how different weapons performed at various distances and against different skill profiles.

The challenge here was making the visualization not just functional, but also **intuitive and interactive**. I wanted users to be able to hover over any cell in the heatmap and see a detailed breakdown of the results, including accuracy, headshot chances, and time-to-kill for that specific matchup.

Using **React** and custom JavaScript, I built the interactive heatmap, where each cell represents a specific weapon-versus-weapon scenario at a given distance. The hover tooltip would display additional stats for each of the four skill profiles, allowing users to understand how weapon performance varied based on the opponent's abilities.

It was immensely satisfying to see the simulation results not just as a table, but as an interactive, visually engaging experience that brought the data to life.

### **The Road Ahead: Enhancements and Future Growth**

While the combat simulator is already a powerful tool, there’s still room for improvement. The next steps for the project involve adding **dynamic movement penalties** to simulate strafing, jumping, and other player movements that affect accuracy. I'm also exploring the integration of **real-time weapon stat updates** so the tool remains accurate even after balance patches in the game.

Furthermore, I’m excited about the potential to add **special gadgets and abilities**, like healing beams, shields, or cloaking devices. These additions would make the simulations more representative of the full *The Finals* experience, and I’m eager to explore how to incorporate them into the system.

### **What I Learned: From Struggles to Growth**

Looking back on this project, it’s clear that the struggles were just as valuable as the successes. Each roadblock I faced taught me something new—whether it was a deeper understanding of parallel programming, performance optimization, or how to manage complex data flows in real-time applications.

This project also taught me the importance of **resilience** and **adaptation**. There were moments when I thought I had reached a dead end, but those moments turned out to be stepping stones to greater learning and innovation.

As I move forward, I’m excited to continue pushing the limits of what’s possible with JavaScript and Web Workers. This combat simulator is just one example of how powerful the web can be when you leverage the right tools and techniques.

---

### **Takeaway for Recruiters**

This project not only showcases my technical skills in JavaScript, performance engineering, and data visualization but also demonstrates my ability to **innovate under pressure**, **problem-solve** at scale, and deliver a **real-time, user-friendly solution**. My experience with **Web Workers**, **parallel programming**, and **asynchronous coordination** proves my capability to tackle complex, data-intensive applications—skills that are highly transferable to any tech-driven project.
